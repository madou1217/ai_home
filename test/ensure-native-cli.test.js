'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  resolveProviderCliPath,
  ensureNativeCliAvailable,
  buildCliNotFoundMessage
} = require('../lib/cli/services/ai-cli/ensure-native-cli');

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
      calls.push({ name, pathHasLocalBin: String(opts.env.PATH || '').includes('.local\\bin') || String(opts.env.PATH || '').includes('.local/bin') });
      if (name === 'qoderclicn') return 'C:\\Users\\example\\.local\\bin\\qoderclicn.exe';
      return '';
    }
  });
  assert.equal(cliPath, 'C:\\Users\\example\\.local\\bin\\qoderclicn.exe');
  assert.equal(calls[0].name, 'qoderclicn');
  assert.equal(calls[0].pathHasLocalBin, true);
});

test('ensureNativeCliAvailable auto-installs when missing then re-resolves', () => {
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
  assert.match(String(spawnCalls[0].args.at(-1) || ''), /qoder\.com\.cn\/install\.ps1/);
  assert.equal(result.installAttempts[0].ok, true);
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

test('buildCliNotFoundMessage mentions binary and install failure', () => {
  const msg = buildCliNotFoundMessage('qodercn', {
    binaryName: 'qoderclicn',
    installAttempts: [{ id: 'x', label: 'Qoder CLI CN official installer', ok: false }]
  });
  assert.match(msg, /qoderclicn/);
  assert.match(msg, /自动安装失败/);
  assert.match(msg, /Qoder CLI CN official installer/);
});
