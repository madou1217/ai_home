'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  resolveProviderCliPath,
  ensureNativeCliAvailable,
  buildCliNotFoundMessage
} = require('../lib/cli/services/ai-cli/ensure-native-cli');
const {
  collectNativeCliPathEntries,
  resolveNativeCliInstallPlans,
  listProviderBinaryNames
} = require('../lib/cli/services/ai-cli/native-cli-installer');
const {
  findInstallStrategy,
  listStrategyBinaryNames
} = require('../lib/cli/services/ai-cli/native-cli-install-strategies');

test('Strategy registry matches qoder / qodercn / claude', () => {
  assert.equal(findInstallStrategy('qoder').name, 'qoder:qoder');
  assert.equal(findInstallStrategy('qodercn').name, 'qoder:qodercn');
  assert.equal(findInstallStrategy('claude').name, 'claude');
  assert.equal(findInstallStrategy('codex'), null);
});

test('listProviderBinaryNames returns strategy binary aliases', () => {
  assert.deepEqual(listProviderBinaryNames('qodercn'), ['qoderclicn']);
  assert.deepEqual(listProviderBinaryNames('qoder'), ['qodercli']);
  assert.ok(listStrategyBinaryNames('qoder').includes('qodercli'));
  // CN must never alias to global qoder binary.
  assert.equal(listProviderBinaryNames('qodercn').includes('qoder'), false);
});

test('collectNativeCliPathEntries covers official Qoder install home layout', () => {
  const cnEntries = collectNativeCliPathEntries('qodercn', {
    path,
    hostHomeDir: 'C:\\Users\\example',
    processObj: {
      platform: 'win32',
      env: {
        LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local',
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)'
      }
    }
  });
  assert.ok(cnEntries.includes(path.win32.join('C:\\Users\\example', '.local', 'bin')));
  // Official CN install path verified via live `qoderclicn install --force`
  assert.ok(cnEntries.includes(path.win32.join('C:\\Users\\example', '.qoder-cn', 'bin', 'qoderclicn')));
  assert.ok(cnEntries.some((entry) => /QoderCN/i.test(entry) || /qoderclicn/i.test(entry)));

  const globalEntries = collectNativeCliPathEntries('qoder', {
    path,
    hostHomeDir: '/home/u',
    processObj: { platform: 'linux', env: { HOME: '/home/u' } }
  });
  assert.ok(globalEntries.includes(path.join('/home/u', '.local', 'bin')));
  assert.ok(globalEntries.includes(path.join('/home/u', '.qoder', 'bin', 'qodercli')));
  assert.ok(globalEntries.includes('/usr/local/bin'));
});

test('resolveProviderCliPath looks up qodercn via binaryName qoderclicn', () => {
  const calls = [];
  const cliPath = resolveProviderCliPath('qodercn', {
    hostHomeDir: 'C:\\Users\\example',
    processObj: {
      platform: 'win32',
      env: { USERPROFILE: 'C:\\Users\\example', PATH: 'C:\\empty' },
      cwd: () => 'C:\\repo'
    },
    path,
    resolveNativeCliPath: (name, opts) => {
      calls.push({
        name,
        pathHasLocalBin: String(opts.env.PATH || '').includes('.local')
      });
      if (name === 'qoderclicn') return 'C:\\Users\\example\\.local\\bin\\qoderclicn.exe';
      return '';
    }
  });
  assert.equal(cliPath, 'C:\\Users\\example\\.local\\bin\\qoderclicn.exe');
  assert.equal(calls[0].name, 'qoderclicn');
  assert.equal(calls[0].pathHasLocalBin, true);
});

test('resolveProviderCliPath resolves the strategy binary before provider fallback', () => {
  const calls = [];
  const cliPath = resolveProviderCliPath('qoder', {
    hostHomeDir: '/home/u',
    processObj: { platform: 'linux', env: { HOME: '/home/u', PATH: '/usr/bin' }, cwd: () => '/repo' },
    path,
    resolveNativeCliPath: (name) => {
      calls.push(name);
      if (name === 'qodercli') return '/usr/local/bin/qodercli';
      return '';
    }
  });
  assert.equal(cliPath, '/usr/local/bin/qodercli');
  assert.deepEqual(calls, ['qodercli']);
});

test('resolveProviderCliPath does not fall back to provider id when binaryName differs', () => {
  const calls = [];
  const cliPath = resolveProviderCliPath('qoder', {
    hostHomeDir: 'C:\\Users\\example',
    processObj: {
      platform: 'win32',
      env: { USERPROFILE: 'C:\\Users\\example', PATH: 'C:\\empty' },
      cwd: () => 'C:\\repo'
    },
    path,
    resolveNativeCliPath(name) {
      calls.push(name);
      return name === 'qoder' ? 'C:\\Program Files\\Qoder\\bin\\qoder.cmd' : '';
    }
  });

  assert.equal(cliPath, '');
  assert.deepEqual(calls, ['qodercli']);
});

test('ensureNativeCliAvailable auto-installs when missing then re-resolves (win32 CN)', () => {
  let present = false;
  const spawnCalls = [];
  const result = ensureNativeCliAvailable('qodercn', {
    hostHomeDir: 'C:\\Users\\example',
    processObj: {
      platform: 'win32',
      env: {
        USERPROFILE: 'C:\\Users\\example',
        PATH: 'C:\\empty',
        SystemRoot: 'C:\\Windows'
      },
      cwd: () => 'C:\\repo'
    },
    path,
    resolveNativeCliPath: (name) => {
      if (name === 'qoderclicn' && present) return 'C:\\Users\\example\\.local\\bin\\qoderclicn.exe';
      return '';
    },
    spawnSync: (command, args) => {
      spawnCalls.push({ command, args });
      present = true;
      return { status: 0, stdout: 'ok', stderr: '' };
    }
  });

  assert.equal(result.installed, true);
  assert.equal(result.cliPath, 'C:\\Users\\example\\.local\\bin\\qoderclicn.exe');
  assert.equal(result.binaryName, 'qoderclicn');
  assert.equal(spawnCalls.length, 1);
  // Preferred plan is direct (manifest → binary install --force)
  assert.match(String(spawnCalls[0].args.at(-1) || ''), /static\.qoder\.com\.cn\/qoder-cli-cn|install --force|qoderclicn/);
  assert.equal(result.installAttempts[0].ok, true);
  assert.match(result.installAttempts[0].id, /qoder_cn_windows/);
});

test('ensureNativeCliAvailable auto-installs on posix global region', () => {
  let present = false;
  const spawnCalls = [];
  const result = ensureNativeCliAvailable('qoder', {
    hostHomeDir: '/home/u',
    processObj: {
      platform: 'linux',
      env: { HOME: '/home/u', PATH: '/usr/bin' },
      cwd: () => '/repo'
    },
    path,
    resolveNativeCliPath: (name) => {
      if ((name === 'qodercli' || name === 'qoder') && present) {
        return path.join('/home/u', '.qoder', 'bin', 'qodercli', 'qodercli');
      }
      return '';
    },
    spawnSync: (command, args) => {
      spawnCalls.push({ command, args });
      present = true;
      return { status: 0, stdout: 'installed', stderr: '' };
    }
  });
  assert.equal(result.installed, true);
  assert.ok(result.cliPath.includes('qodercli'));
  assert.equal(spawnCalls[0].command, 'bash');
});

test('ensureNativeCliAvailable does not install when autoInstall=false', () => {
  const result = ensureNativeCliAvailable('qoder', {
    autoInstall: false,
    hostHomeDir: '/home/u',
    processObj: { platform: 'linux', env: { HOME: '/home/u', PATH: '/usr/bin' }, cwd: () => '/repo' },
    path,
    resolveNativeCliPath: () => '',
    spawnSync: () => {
      throw new Error('spawn should not run');
    }
  });
  assert.equal(result.cliPath, '');
  assert.equal(result.installed, false);
  assert.deepEqual(result.installAttempts, []);
});

test('resolveNativeCliInstallPlans prefers direct install then official script', () => {
  const winGlobal = resolveNativeCliInstallPlans('qoder', '@qoder-ai/qodercli', {
    path,
    hostHomeDir: 'C:\\Users\\example',
    processObj: { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } },
    resolveNpmInstall: () => ({ command: 'npm.cmd', args: ['install', '-g', '@qoder-ai/qodercli'] })
  });
  assert.equal(winGlobal[0].id, 'qoder_global_windows_direct');
  assert.ok(winGlobal.some((p) => p.id === 'qoder_global_windows_script'));
  assert.ok(winGlobal.some((p) => p.id === 'npm_global'));

  const posixCn = resolveNativeCliInstallPlans('qodercn', '', {
    path,
    hostHomeDir: '/home/u',
    processObj: { platform: 'darwin', env: {} }
  });
  assert.ok(posixCn.length >= 1);
  assert.equal(posixCn[0].id, 'qoder_cn_posix_script');
});

test('buildCliNotFoundMessage mentions binary and install failure detail', () => {
  const msg = buildCliNotFoundMessage('qodercn', {
    binaryName: 'qoderclicn',
    installAttempts: [{
      id: 'x',
      label: 'Qoder CLI CN official installer',
      ok: false,
      error: 'download timeout'
    }]
  });
  assert.match(msg, /qoderclicn/);
  assert.match(msg, /自动安装失败/);
  assert.match(msg, /Qoder CLI CN official installer/);
  assert.match(msg, /download timeout/);
});

test('end-to-end closed loop: missing → strategy install plan → re-resolve (simulated)', () => {
  // Full closed loop without network: Strategy yields plan, Template Method runs it,
  // then Facade re-resolves binaryName.
  const hostHomeDir = 'C:\\Users\\sim';
  let installed = false;
  const result = ensureNativeCliAvailable('qodercn', {
    hostHomeDir,
    processObj: {
      platform: 'win32',
      env: {
        USERPROFILE: hostHomeDir,
        LOCALAPPDATA: path.join(hostHomeDir, 'AppData', 'Local'),
        PATH: 'C:\\Windows\\System32',
        SystemRoot: 'C:\\Windows'
      },
      cwd: () => 'C:\\repo'
    },
    path,
    resolveNativeCliPath: (name, opts) => {
      if (!installed) return '';
      // After install, binary is discoverable under strategy path entry.
      if (name === 'qoderclicn' && String(opts.env.PATH || '').includes('Local')) {
        return path.join(hostHomeDir, 'AppData', 'Local', 'qoderclicn', 'qoderclicn.exe');
      }
      if (name === 'qoderclicn') {
        return path.join(hostHomeDir, '.local', 'bin', 'qoderclicn.exe');
      }
      return '';
    },
    spawnSync: () => {
      installed = true;
      return { status: 0, stdout: 'Qoder CLI CN installed', stderr: '' };
    }
  });
  assert.equal(result.installed, true);
  assert.ok(result.cliPath);
  assert.equal(result.binaryName, 'qoderclicn');
  assert.equal(result.installAttempts.length, 1);
  assert.equal(result.installAttempts[0].ok, true);
});
