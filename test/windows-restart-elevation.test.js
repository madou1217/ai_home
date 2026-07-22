'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ELEVATED_RESTART_ENV,
  createWindowsRestartElevation
} = require('../lib/cli/services/server/windows-restart-elevation');

test('Windows restart elevation replays the command through one UAC prompt', () => {
  const calls = [];
  const elevate = createWindowsRestartElevation({
    entryFilePath: 'C:\\repo with spaces\\bin\\ai-home.js',
    aiHomeDir: 'C:\\Users\\alice\\.ai_home',
    processObj: {
      platform: 'win32',
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      env: {}
    },
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    }
  });

  assert.deepEqual(elevate(), { ok: true, elevated: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'powershell.exe');
  assert.equal(calls[0].options.windowsHide, true);
  const encoded = calls[0].args[calls[0].args.indexOf('-EncodedCommand') + 1];
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.match(script, /\$ProgressPreference = 'SilentlyContinue'/);
  assert.match(script, /Start-Process -FilePath 'C:\\Program Files\\nodejs\\node\.exe'/);
  assert.match(script, /-ArgumentList '\"C:\\repo with spaces\\bin\\ai-home\.js\" \"server\" \"restart\"'/);
  assert.match(script, /-WorkingDirectory 'C:\\repo with spaces\\bin'/);
  assert.match(script, /-Verb RunAs/);
  assert.match(script, /-Verb RunAs -PassThru/);
  assert.match(script, /\$restartProcess\.WaitForExit\(\)/);
  assert.match(script, /exit \$restartProcess\.ExitCode/);
  assert.match(script, new RegExp(`\\$env:${ELEVATED_RESTART_ENV} = '1'`));
  assert.match(script, /\$env:AIH_HOME = 'C:\\Users\\alice\\\.ai_home'/);
});

test('Windows restart elevation prevents recursive UAC attempts', () => {
  let spawnCalls = 0;
  const elevate = createWindowsRestartElevation({
    entryFilePath: 'C:\\repo\\bin\\ai-home.js',
    processObj: {
      platform: 'win32',
      execPath: 'node.exe',
      env: { [ELEVATED_RESTART_ENV]: '1' }
    },
    spawnSync() {
      spawnCalls += 1;
      return { status: 0 };
    }
  });

  assert.deepEqual(elevate(), { ok: false, reason: 'already_elevated_attempt' });
  assert.equal(spawnCalls, 0);
});

test('Windows restart elevation treats a cancelled UAC prompt as failure', () => {
  const elevate = createWindowsRestartElevation({
    entryFilePath: 'C:\\repo\\bin\\ai-home.js',
    processObj: { platform: 'win32', execPath: 'node.exe', env: {} },
    spawnSync() {
      return { status: null, signal: 'SIGTERM' };
    }
  });

  assert.deepEqual(elevate(), {
    ok: false,
    reason: 'elevated_restart_failed',
    status: null
  });
});

test('restart elevation is disabled outside Windows', () => {
  const elevate = createWindowsRestartElevation({
    entryFilePath: '/repo/bin/ai-home.js',
    processObj: { platform: 'linux', execPath: '/usr/bin/node', env: {} },
    spawnSync() {
      throw new Error('must not spawn');
    }
  });

  assert.deepEqual(elevate(), { ok: false, reason: 'unsupported_platform' });
});
