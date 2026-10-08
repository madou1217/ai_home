'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { getProviderCLIConfig } = require('../lib/provider-catalog');
const {
  getDesktopLaunchStrategy, parseDesktopInstance, resolveDesktopInstanceName
} = require('../lib/server/desktop-launch');
const {
  createAccountAppLauncher, createAppEntryDetector, findRunningDesktopPids,
  listRunningDesktopInstances, resolveDesktopExecutable
} = require('../lib/server/account-app-launcher');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';
const OTHER_REF = 'acct_abcdef0123456789abcd';
const GUI = '/Applications/Kiro CLI.app/Contents/MacOS/kiro_cli_desktop';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kiro-desktop-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profileDir = path.join(root, 'profile');
  const fsImpl = {
    ...fs,
    existsSync(candidate) {
      if (String(candidate).startsWith('/Applications/')) {
        return candidate === '/Applications/Kiro CLI.app' || candidate === GUI;
      }
      return fs.existsSync(candidate);
    }
  };
  return { root, profileDir, fsImpl };
}

test('Kiro app discovery recognizes Kiro CLI.app and resolves its native GUI executable', t => {
  const { root, fsImpl } = fixture(t);
  const config = getProviderCLIConfig('kiro').desktopClient.macos;
  const resolved = resolveDesktopExecutable('macos', config, { fs: fsImpl, path, env: {}, hostHomeDir: root });
  assert.deepEqual(resolved, { executablePath: GUI, bundlePath: '/Applications/Kiro CLI.app' });
  const detector = createAppEntryDetector({ fs: fsImpl, path, hostHomeDir: root,
    processObj: { platform: 'darwin', env: { HOME: root, PATH: '' } }, execFileSync: () => '' });
  assert.equal(detector.detect().kiro.desktop, true);
});

test('Kiro native GUI launch, reuse, status and close all address the same exact account', t => {
  const { root, profileDir, fsImpl } = fixture(t);
  const calls = [];
  const signals = [];
  const instances = new Map();
  const marker = resolveDesktopInstanceName('kiro', ACCOUNT_REF);
  const otherMarker = resolveDesktopInstanceName('kiro', OTHER_REF);
  instances.set(9099, `${otherMarker} --allow-multiple`);
  instances.set(9199, `${GUI} --no-dashboard`);
  const launcher = createAccountAppLauncher({
    fs: fsImpl, path, hostHomeDir: root, aiHomeDir: path.join(root, 'aih'),
    processObj: { platform: 'darwin', env: { HOME: root, USERPROFILE: root, PATH: '' },
      kill(pid, signal) {
        signals.push([pid, signal]);
        if (!instances.has(pid)) throw Object.assign(new Error('missing'), { code: 'ESRCH' });
        if (signal === 'SIGTERM' || signal === 'SIGKILL') instances.delete(pid);
      }
    },
    resolveAccount: () => ({ provider: 'kiro', accountRef: ACCOUNT_REF, cliAccountId: '1' }),
    getProfileDir: () => profileDir, readAccountEnv: () => ({}),
    execFileSync: () => [...instances].map(([pid, command]) => `${pid} ${command}`).join('\n'),
    spawn(file, args, options) {
      calls.push({ file, args, options });
      instances.set(9001, `${args[2]} --allow-multiple`);
      return { pid: 9001, unref() {} };
    },
    stopGraceMs: 1
  });
  const input = { provider: 'kiro', accountRef: ACCOUNT_REF, kind: 'desktop' };
  const launched = launcher.launchAccountApp(input);
  assert.equal(launched.status, 'launched', JSON.stringify(launched));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, '/bin/bash');
  assert.deepEqual(calls[0].args, ['-c', 'exec -a "$0" "$@"', marker, GUI, '--allow-multiple']);
  assert.equal(calls[0].options.env.HOME, profileDir);
  assert.equal(calls[0].options.env.KIRO_TEST_DB_PATH, path.join(profileDir, 'data.sqlite3'));
  assert.equal(calls[0].options.env.TMPDIR, path.join(profileDir, 'tmp') + path.sep);
  assert.equal(calls[0].args.some(arg => arg.startsWith('--user-data-dir')), false);
  assert.equal(fs.lstatSync(path.join(profileDir, 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3')).isSymbolicLink(), true);
  const reused = launcher.launchAccountApp(input);
  assert.equal(reused.status, 'already_running');
  assert.deepEqual(reused.pids, [9001]);
  assert.equal(calls.length, 1);
  const inspected = launcher.launchAccountApp({ ...input, inspectDesktopRunning: true });
  assert.deepEqual(inspected.pids, [9001]);
  const closed = launcher.launchAccountApp({ ...input, action: 'close' });
  assert.deepEqual(closed.pids, [9001]);
  assert.equal(instances.has(9099), true);
  assert.equal(instances.has(9199), true);
  assert.deepEqual(signals, [[9001, 'SIGTERM'], [9001, 0]]);
});

test('Kiro process ownership ignores other accounts, the host app and arbitrary wrapper commands', () => {
  const marker = resolveDesktopInstanceName('kiro', ACCOUNT_REF);
  const otherMarker = resolveDesktopInstanceName('kiro', OTHER_REF);
  const execFileSync = () => [
    `9001 ${marker} --allow-multiple`, `9002 ${otherMarker} --allow-multiple`,
    `9003 ${GUI} --no-dashboard`, `9004 /bin/sh -c ${marker}`, `9005 ${marker} --type=utility`
  ].join('\n');
  assert.deepEqual(parseDesktopInstance(`${marker} --allow-multiple`), { provider: 'kiro', name: marker });
  assert.equal(parseDesktopInstance(`/bin/sh -c ${marker}`), null);
  assert.deepEqual(findRunningDesktopPids('/profile/electron-user-data', { execNames: ['kiro_cli_desktop'] }, 'macos', {
    execFileSync, applicationName: marker
  }), [9001]);
  assert.deepEqual(listRunningDesktopInstances('macos', { execFileSync }), [
    { pid: 9001, applicationName: marker }, { pid: 9002, applicationName: otherMarker }
  ]);
});

test('Kiro IDE executables preserve the existing Electron spawn contract on all platforms', () => {
  const strategy = getDesktopLaunchStrategy('kiro');
  for (const [platformKey, executablePath] of [
    ['macos', '/Applications/Kiro.app/Contents/MacOS/Kiro'],
    ['windows', 'C:\\Kiro\\Kiro.exe'], ['linux', '/opt/kiro/kiro']
  ]) {
    const ctx = { path, platformKey, userDataDir: '/profile/electron-user-data' };
    assert.deepEqual(strategy.resolveSpawnPlan({ executablePath }, ctx), {
      file: executablePath, args: ['--user-data-dir=/profile/electron-user-data']
    });
  }
});

test('Kiro desktop keeps sessions in the host ~/.kiro while the credential database stays per account', () => {
  const { kiroDesktopLaunchStrategy } = require('../lib/server/desktop-launch/kiro-strategy');
  const env = {};
  const resolved = { executablePath: '/Applications/Kiro CLI.app/Contents/MacOS/kiro_cli_desktop' };
  kiroDesktopLaunchStrategy.decorateResolvedLaunchEnv(env, resolved, {
    platformKey: 'macos', path, profileDir: '/aih/run/auth-projections/kiro/acct_1', hostHomeDir: '/Users/u'
  });
  assert.equal(env.KIRO_HOME, '/Users/u/.kiro');
  assert.equal(env.KIRO_TEST_DB_PATH, '/aih/run/auth-projections/kiro/acct_1/data.sqlite3');
});
