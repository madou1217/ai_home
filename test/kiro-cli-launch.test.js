'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveProviderCliPath } = require('../lib/cli/services/ai-cli/ensure-native-cli');
const { resolveProviderCliExecutable } = require('../lib/runtime/provider-cli-executable');
const { kiroStrategy } = require('../lib/cli/services/ai-cli/launch-profile/kiro-strategy');
const { prepareKiroRuntimeHome } = require('../lib/runtime/kiro-runtime-home');
const { createSessionStoreService } = require('../lib/cli/services/session-store');
const createPtyRuntimeLaunchDomain = require('../lib/cli/services/pty/pty-runtime-launch');

const resolveCliExecutable = (cliPath, options) => resolveProviderCliExecutable('kiro', cliPath, options);

function binaries(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kiro-binary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'Kiro CLI.app', 'Contents', 'MacOS');
  fs.mkdirSync(directory, { recursive: true });
  const main = path.join(directory, 'kiro-cli');
  const chat = path.join(directory, 'kiro-cli-chat');
  fs.writeFileSync(main, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(chat, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  return { root, main, chat };
}

test('Kiro chooses the auth-isolated chat binary from the same installation behind a symlink', t => {
  const { root, main, chat } = binaries(t);
  const shim = path.join(root, 'kiro-cli');
  fs.symlinkSync(main, shim);
  const actual = resolveProviderCliPath('kiro', {
    fs,
    hostHomeDir: root,
    processObj: { platform: process.platform, env: { HOME: root, PATH: root }, cwd: () => root },
    resolveNativeCliPath: name => name === 'kiro-cli' ? shim : ''
  });
  assert.equal(actual, fs.realpathSync(chat));
});

test('Kiro keeps standalone binaries and explicit chat binaries intact', t => {
  const { root, chat } = binaries(t);
  const standalone = path.join(root, 'kiro-cli');
  fs.writeFileSync(standalone, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  assert.equal(typeof resolveCliExecutable, 'function');
  assert.equal(resolveCliExecutable(standalone, { fs, path, platform: process.platform }), standalone);
  assert.equal(resolveCliExecutable(chat, { fs, path, platform: process.platform }), chat);
});

test('Kiro never chooses its shell-integration binary as the chat executable', t => {
  const { root } = binaries(t);
  const main = path.join(root, 'kiro-cli');
  const term = path.join(root, 'kiro-cli-term');
  fs.writeFileSync(main, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(term, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  assert.equal(resolveCliExecutable(main, { fs, path, platform: process.platform }), main);
});

test('Kiro PTY launch chooses terminal chat by default and preserves login/explicit arguments', () => {
  const domain = createPtyRuntimeLaunchDomain({ fs, path }, { codexLaunchSupport: {} });
  assert.deepEqual(domain.normalizeRuntimeForwardArgs('kiro', []), ['chat']);
  assert.deepEqual(domain.normalizeRuntimeForwardArgs('kiro', ['login', '--use-device-flow'], { isLogin: true }), ['login', '--use-device-flow']);
  assert.deepEqual(domain.normalizeRuntimeForwardArgs('kiro', ['chat', '--resume']), ['chat', '--resume']);
});

test('Kiro CLI runs in the real HOME and only redirects its credential database', t => {
  const { root } = binaries(t);
  const sandboxDir = path.join(root, 'account');
  const hostHomeDir = path.join(root, 'host');
  kiroStrategy.prepare({ fs, path, sandboxDir, hostHomeDir, platform: 'darwin' });
  const { set, unset } = kiroStrategy.buildEnvPatch({ path, sandboxDir, hostHomeDir });
  assert.equal(set.HOME, hostHomeDir);
  assert.equal(set.USERPROFILE, hostHomeDir);
  assert.equal(set.KIRO_TEST_DB_PATH, path.join(sandboxDir, 'data.sqlite3'));
  assert.equal(set.XDG_CACHE_HOME, path.join(hostHomeDir, '.cache'));
  // 会话写宿主原生 ~/.kiro：不能把 KIRO_HOME/TMPDIR/XDG 数据目录指到账号目录。
  for (const key of ['KIRO_HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
    assert.equal(Object.hasOwn(set, key), false, key);
  }
  assert.ok(unset.includes('KIRO_HOME'));
  assert.deepEqual(fs.readdirSync(sandboxDir), [], 'the account directory holds nothing but the credential database');
});

test('Kiro refuses to overwrite an unknown native database or linked private directory', t => {
  const { root } = binaries(t);
  const sandboxDir = path.join(root, 'account');
  const nativeDir = path.join(sandboxDir, 'Library', 'Application Support', 'kiro-cli');
  fs.mkdirSync(nativeDir, { recursive: true });
  const nativeDatabase = path.join(nativeDir, 'data.sqlite3');
  fs.writeFileSync(nativeDatabase, 'existing-state');
  assert.throws(() => prepareKiroRuntimeHome({ fs, path, sandboxDir, platform: 'darwin' }), /kiro_native_database_path_conflict/);
  assert.equal(fs.readFileSync(nativeDatabase, 'utf8'), 'existing-state');
  const other = path.join(root, 'linked-account');
  fs.mkdirSync(other);
  fs.symlinkSync(root, path.join(other, 'Library'), 'dir');
  assert.throws(() => prepareKiroRuntimeHome({ fs, path, sandboxDir: other, platform: 'darwin' }), /not_private/);
});

test('Kiro session reconciliation links nothing: the account directory only holds credentials', t => {
  const { root } = binaries(t);
  const sandboxDir = path.join(root, 'account');
  const hostHomeDir = path.join(root, 'host');
  fs.mkdirSync(sandboxDir, { recursive: true });
  fs.writeFileSync(path.join(sandboxDir, 'data.sqlite3'), 'account-credentials');
  fs.mkdirSync(path.join(hostHomeDir, '.kiro', 'sessions', 'cli'), { recursive: true });
  const service = createSessionStoreService({
    fs, path, hostHomeDir, aiHomeDir: path.join(root, 'aih'),
    processObj: { platform: 'darwin' },
    cliConfigs: { kiro: { globalDir: '.kiro' } }
  });
  const runtime = { projectionRoot: sandboxDir };

  assert.deepEqual(service.ensureSessionStoreLinks('kiro', 'acct_0123456789abcdef0123', runtime), {
    migrated: 0, linked: 0
  });
  assert.deepEqual(fs.readdirSync(sandboxDir), ['data.sqlite3']);
  assert.deepEqual(fs.readdirSync(hostHomeDir), ['.kiro'], 'nothing is created in the host home');
});
