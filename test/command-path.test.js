const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveCommandPath, resolveCommandPathDetailed } = require('../lib/runtime/command-path');

test('resolveCommandPath returns empty for blank command', () => {
  assert.equal(resolveCommandPath(''), '');
});

test('resolveCommandPath uses where on win32 and returns first match', () => {
  const calls = [];
  const env = { Path: '' };
  const out = resolveCommandPath('codex', {
    env,
    platform: 'win32',
    spawnSyncImpl: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return {
        status: 0,
        stdout: 'C:\\\\Users\\\\me\\\\AppData\\\\Roaming\\\\npm\\\\codex.cmd\r\nC:\\\\another\\\\codex.cmd\r\n'
      };
    }
  });

  assert.equal(out, 'C:\\\\Users\\\\me\\\\AppData\\\\Roaming\\\\npm\\\\codex.cmd');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'where.exe');
  assert.deepEqual(calls[0].args, ['codex']);
  assert.equal(calls[0].options.env, env);
});

test('resolveCommandPath returns empty on win32 probe failure', () => {
  const out = resolveCommandPath('codex', {
    env: { Path: '' },
    platform: 'win32',
    spawnSyncImpl: () => ({ status: 1, stdout: '' })
  });
  assert.equal(out, '');
});

test('resolveCommandPath prefers Windows PATHEXT shim over extensionless POSIX script', () => {
  const resolved = resolveCommandPath('qoder', {
    platform: 'win32',
    env: { PATH: '', PATHEXT: '.EXE;.CMD;.BAT;.COM' },
    spawnSyncImpl(command, args) {
      assert.equal(command, 'where.exe');
      assert.deepEqual(args, ['qoder']);
      return {
        status: 0,
        stdout: [
          'C:\\Program Files\\Qoder\\bin\\qoder',
          'C:\\Program Files\\Qoder\\bin\\qoder.cmd'
        ].join('\r\n')
      };
    }
  });

  assert.equal(resolved, 'C:\\Program Files\\Qoder\\bin\\qoder.cmd');
});

test('resolveCommandPath uses command -v on linux and trims output', () => {
  const calls = [];
  const env = { PATH: '' };
  const out = resolveCommandPath('codex', {
    env,
    platform: 'linux',
    spawnSyncImpl: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { status: 0, stdout: '/usr/local/bin/codex\n' };
    }
  });

  assert.equal(out, '/usr/local/bin/codex');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'sh');
  assert.equal(calls[0].args[0], '-lc');
  assert.match(calls[0].args[1], /command -v "codex"/);
  assert.equal(calls[0].options.env, env);
});

test('resolveCommandPath escapes special characters for shell probing', () => {
  let commandString = '';
  resolveCommandPath('co"de$x`', {
    env: { PATH: '' },
    platform: 'linux',
    spawnSyncImpl: (_cmd, args) => {
      commandString = args[1];
      return { status: 0, stdout: '/tmp/fake\n' };
    }
  });

  assert.equal(commandString, 'command -v "co\\"de\\$x\\`"');
});

test('resolveCommandPath prioritizes deterministic PATH scan before probe', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cmdpath-'));
  const windows = process.platform === 'win32';
  const fakeCmd = path.join(tmpDir, windows ? 'codex.cmd' : 'codex');
  fs.writeFileSync(fakeCmd, windows ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
  if (!windows) fs.chmodSync(fakeCmd, 0o755);

  const out = resolveCommandPath('codex', {
    platform: process.platform,
    env: windows
      ? { Path: tmpDir, PATHEXT: '.CMD;.EXE;.BAT;.COM' }
      : { PATH: `${tmpDir}:/usr/local/bin:/usr/bin` },
    spawnSyncImpl: () => {
      throw new Error('probe should not be called when PATH scan resolves');
    }
  });

  assert.equal(out, fakeCmd);
});

test('resolveCommandPath ignores non-file PATH candidates', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cmdpath-dir-'));
  const fakeDirCandidate = path.join(tmpDir, 'codex');
  fs.mkdirSync(fakeDirCandidate);

  const out = resolveCommandPath('codex', {
    platform: 'linux',
    env: { PATH: tmpDir },
    spawnSyncImpl: () => ({ status: 0, stdout: '/usr/local/bin/codex\n' })
  });

  assert.equal(out, '/usr/local/bin/codex');
});

test('resolveCommandPath ignores non-executable PATH files on linux', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cmdpath-file-'));
  const fakeFileCandidate = path.join(tmpDir, 'codex');
  fs.writeFileSync(fakeFileCandidate, '#!/bin/sh\necho fake\n', 'utf8');
  fs.chmodSync(fakeFileCandidate, 0o644);

  const out = resolveCommandPath('codex', {
    platform: 'linux',
    env: { PATH: tmpDir },
    spawnSyncImpl: () => ({ status: 0, stdout: '/usr/bin/codex\n' })
  });

  assert.equal(out, '/usr/bin/codex');
});

test('resolveCommandPathDetailed exposes actionable diagnostics when unresolved', () => {
  const detail = resolveCommandPathDetailed('codex', {
    platform: 'linux',
    env: { PATH: '' },
    spawnSyncImpl: () => ({ status: 1, stdout: '' })
  });

  assert.equal(detail.path, '');
  assert.equal(detail.errorCode, 'COMMAND_NOT_FOUND');
  assert.match(detail.remediation, /Install 'codex'/);
  assert.ok(detail.attempts.some((item) => item.step === 'path_scan' && item.status === 'skip'));
  assert.ok(detail.attempts.some((item) => item.step === 'command_v_probe'));
});
