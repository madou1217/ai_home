const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDesktopClientRestartService,
  extractMacAppBundlePath
} = require('../lib/cli/services/ai-cli/desktop-client-restart');

test('extractMacAppBundlePath derives .app root from executable path', () => {
  assert.equal(
    extractMacAppBundlePath('/Applications/Codex.app/Contents/MacOS/Codex'),
    '/Applications/Codex.app'
  );
});

test('desktop client restart relaunches matching macOS app bundle executable', () => {
  const killCalls = [];
  const launches = [];
  const writes = [];
  let aliveChecks = 0;
  const service = createDesktopClientRestartService({
    aiHomeDir: '/tmp/aih',
    stopWaitTimeoutMs: 1000,
    stopWaitIntervalMs: 1,
    fs: {
      mkdirSync: () => {},
      writeFileSync: (target, value) => writes.push({ target, value }),
      readFileSync: () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      existsSync: () => true
    },
    processObj: {
      platform: 'darwin',
      pid: 999,
      kill: (pid, signal) => {
        killCalls.push({ pid, signal });
        if (signal === 0) {
          aliveChecks += 1;
          if (aliveChecks >= 3) throw new Error('not running');
          return;
        }
      }
    },
    spawnSync: (command, args) => {
      if (command === 'ps') {
        assert.deepEqual(args, ['-ax', '-o', 'pid=,command=']);
        return {
          status: 0,
          stdout: '123 /Applications/Codex.app/Contents/MacOS/Codex\n'
        };
      }
      if (command === 'osascript') {
        return { status: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected command ${command}`);
    },
    spawn: (command, args, options) => {
      launches.push({ command, args, options });
      return {
        unref: () => launches.push({ unref: true })
      };
    }
  });

  const result = service.restartDetectedDesktopClient('codex');

  assert.equal(killCalls.some((item) => item.signal === 'SIGTERM'), false);
  assert.equal(killCalls.filter((item) => item.signal === 0).length >= 2, true);
  assert.equal(result.detected, true);
  assert.equal(result.restarted, true);
  assert.equal(result.clientName, 'Codex');
  assert.equal(result.cachedPathUpdated, true);
  assert.equal(result.stopMode, 'applescript');
  assert.equal(launches[0].command, 'open');
  assert.deepEqual(launches[0].args, ['-a', '/Applications/Codex.app']);
  assert.equal(launches[0].options.detached, true);
  assert.equal(writes[0].target, '/tmp/aih/desktop-client-paths.json');
  assert.equal(writes[0].value.includes('/Applications/Codex.app/Contents/MacOS/Codex'), true);
  assert.equal(writes[0].value.includes('/Applications/Codex.app'), true);
});

test('desktop client restart force-kills macOS app when graceful quit times out', () => {
  const killCalls = [];
  const launches = [];
  let forceKilled = false;
  const service = createDesktopClientRestartService({
    aiHomeDir: '/tmp/aih',
    stopWaitTimeoutMs: 5,
    stopWaitIntervalMs: 1,
    fs: {
      mkdirSync: () => {},
      writeFileSync: () => {},
      readFileSync: () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      existsSync: () => true
    },
    processObj: {
      platform: 'darwin',
      pid: 999,
      kill: (pid, signal) => {
        killCalls.push({ pid, signal });
        if (signal === 0) {
          if (forceKilled) throw new Error('not running');
          return;
        }
        if (signal === 'SIGKILL') forceKilled = true;
      }
    },
    spawnSync: (command, args) => {
      if (command === 'ps') {
        return {
          status: 0,
          stdout: '123 /Applications/Codex.app/Contents/MacOS/Codex\n'
        };
      }
      if (command === 'osascript') {
        return { status: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected command ${command}`);
    },
    spawn: (command, args, options) => {
      launches.push({ command, args, options });
      return { unref: () => {} };
    }
  });

  const result = service.restartDetectedDesktopClient('codex');

  assert.equal(result.restarted, true);
  assert.equal(result.forceQuit, true);
  assert.equal(result.stopMode, 'force_kill');
  assert.equal(killCalls.some((item) => item.signal === 'SIGKILL'), true);
  assert.equal(launches[0].command, 'open');
});

test('desktop client restart force-kills immediately when requested', () => {
  const killCalls = [];
  const launches = [];
  const syncCalls = [];
  let forceKilled = false;
  const service = createDesktopClientRestartService({
    aiHomeDir: '/tmp/aih',
    stopWaitTimeoutMs: 1000,
    stopWaitIntervalMs: 1,
    fs: {
      mkdirSync: () => {},
      writeFileSync: () => {},
      readFileSync: () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      existsSync: () => true
    },
    processObj: {
      platform: 'darwin',
      pid: 999,
      kill: (pid, signal) => {
        killCalls.push({ pid, signal });
        if (signal === 0) {
          if (forceKilled) throw new Error('not running');
          return;
        }
        if (signal === 'SIGKILL') forceKilled = true;
      }
    },
    spawnSync: (command, args) => {
      syncCalls.push({ command, args });
      if (command === 'ps') {
        return {
          status: 0,
          stdout: '123 /Applications/Codex.app/Contents/MacOS/Codex\n'
        };
      }
      if (command === 'osascript') {
        throw new Error('should not use graceful quit when force quit is requested');
      }
      throw new Error(`unexpected command ${command}`);
    },
    spawn: (command, args, options) => {
      launches.push({ command, args, options });
      return { unref: () => {} };
    }
  });

  const result = service.restartDetectedDesktopClient('codex', { forceQuit: true });

  assert.equal(result.restarted, true);
  assert.equal(result.forceQuit, true);
  assert.equal(result.stopMode, 'force_kill');
  assert.equal(killCalls.some((item) => item.signal === 'SIGKILL'), true);
  assert.deepEqual(syncCalls, [{
    command: 'ps',
    args: ['-ax', '-o', 'pid=,command=']
  }]);
  assert.equal(launches[0].command, 'open');
});

test('desktop client restart uses taskkill and relaunch on windows', () => {
  const syncCalls = [];
  const launches = [];
  let aliveChecks = 0;
  const service = createDesktopClientRestartService({
    aiHomeDir: '/tmp/aih',
    stopWaitTimeoutMs: 1000,
    stopWaitIntervalMs: 1,
    fs: {
      mkdirSync: () => {},
      writeFileSync: () => {},
      readFileSync: () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      existsSync: () => true
    },
    processObj: {
      platform: 'win32',
      pid: 888,
      kill: (pid, signal) => {
        if (signal === 0) {
          aliveChecks += 1;
          if (aliveChecks >= 2) throw new Error('not running');
        }
      }
    },
    spawnSync: (command, args) => {
      syncCalls.push({ command, args });
      if (command === 'powershell.exe') {
        return {
          status: 0,
          stdout: '[{"ProcessId":321,"Name":"Codex.exe","ExecutablePath":"C:\\\\Program Files\\\\OpenAI\\\\Codex.exe","CommandLine":"\\"C:\\\\Program Files\\\\OpenAI\\\\Codex.exe\\""}]'
        };
      }
      if (command === 'taskkill') {
        return { status: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected command ${command}`);
    },
    spawn: (command, args, options) => {
      launches.push({ command, args, options });
      return {
        unref: () => launches.push({ unref: true })
      };
    }
  });

  const result = service.restartDetectedDesktopClient('codex');

  assert.equal(result.detected, true);
  assert.equal(result.restarted, true);
  assert.deepEqual(syncCalls[1], {
    command: 'taskkill',
    args: ['/PID', '321', '/T', '/F']
  });
  assert.equal(launches[0].command, 'C:\\Program Files\\OpenAI\\Codex.exe');
  assert.deepEqual(launches[0].args, []);
  assert.equal(launches[0].options.windowsHide, true);
});

test('desktop client restart avoids matching plain linux codex cli process by default', () => {
  const launches = [];
  const service = createDesktopClientRestartService({
    aiHomeDir: '/tmp/aih',
    fs: {
      mkdirSync: () => {},
      writeFileSync: () => {},
      readFileSync: () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      existsSync: () => true
    },
    processObj: {
      platform: 'linux',
      pid: 777,
      kill: () => {
        throw new Error('should not kill');
      }
    },
    spawnSync: () => ({
      status: 0,
      stdout: '456 /usr/bin/codex login\n'
    }),
    spawn: (command, args, options) => {
      launches.push({ command, args, options });
      return { unref: () => {} };
    }
  });

  const result = service.restartDetectedDesktopClient('codex');

  assert.equal(result.detected, false);
  assert.equal(result.restarted, false);
  assert.equal(launches.length, 0);
});

test('desktop client restart launches learned path when app is not running', () => {
  const launches = [];
  const service = createDesktopClientRestartService({
    aiHomeDir: '/tmp/aih',
    fs: {
      mkdirSync: () => {},
      writeFileSync: () => {},
      readFileSync: () => JSON.stringify({
        codex: {
          macos: {
            clientName: 'Codex',
            executablePath: '/Applications/Codex.app/Contents/MacOS/Codex',
            bundlePath: '/Applications/Codex.app'
          }
        }
      }),
      existsSync: (target) => String(target) === '/Applications/Codex.app'
    },
    processObj: {
      platform: 'darwin',
      pid: 999,
      kill: () => {
        throw new Error('should not kill');
      }
    },
    spawnSync: () => ({
      status: 0,
      stdout: ''
    }),
    spawn: (command, args, options) => {
      launches.push({ command, args, options });
      return { unref: () => {} };
    }
  });

  const result = service.restartDetectedDesktopClient('codex');

  assert.equal(result.detected, false);
  assert.equal(result.restarted, false);
  assert.equal(result.launched, true);
  assert.equal(result.usedSavedPath, true);
  assert.equal(launches[0].command, 'open');
  assert.deepEqual(launches[0].args, ['-a', '/Applications/Codex.app']);
});

test('desktop client restart reminds caller when app is not running and no learned path exists', () => {
  const service = createDesktopClientRestartService({
    aiHomeDir: '/tmp/aih',
    fs: {
      mkdirSync: () => {},
      writeFileSync: () => {},
      readFileSync: () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      existsSync: () => false
    },
    processObj: {
      platform: 'darwin',
      pid: 999,
      kill: () => {
        throw new Error('should not kill');
      }
    },
    spawnSync: () => ({
      status: 0,
      stdout: ''
    }),
    spawn: () => {
      throw new Error('should not spawn');
    }
  });

  const result = service.restartDetectedDesktopClient('codex');

  assert.equal(result.detected, false);
  assert.equal(result.restarted, false);
  assert.equal(result.launched, false);
  assert.equal(result.reason, 'no_saved_path');
});

test('desktop client restart ignores non-app codex binaries on macOS', () => {
  const service = createDesktopClientRestartService({
    aiHomeDir: '/tmp/aih',
    fs: {
      mkdirSync: () => {},
      writeFileSync: () => {},
      readFileSync: () => JSON.stringify({
        codex: {
          macos: {
            clientName: 'Codex',
            executablePath: '/Users/model/.vscode/extensions/openai.chatgpt/bin/macos-aarch64/codex'
          }
        }
      }),
      existsSync: () => false
    },
    processObj: {
      platform: 'darwin',
      pid: 999,
      kill: () => {
        throw new Error('should not kill');
      }
    },
    spawnSync: () => ({
      status: 0,
      stdout: '222 /Users/model/.vscode/extensions/openai.chatgpt/bin/macos-aarch64/codex\n'
    }),
    spawn: () => {
      throw new Error('should not spawn');
    }
  });

  const result = service.restartDetectedDesktopClient('codex');

  assert.equal(result.detected, false);
  assert.equal(result.launched, false);
  assert.equal(result.reason, 'no_saved_path');
});

test('desktop client restart launches installed macOS app bundle when cache is missing', () => {
  const launches = [];
  const writes = [];
  const service = createDesktopClientRestartService({
    aiHomeDir: '/tmp/aih',
    hostHomeDir: '/Users/model',
    fs: {
      mkdirSync: () => {},
      writeFileSync: (target, value) => writes.push({ target, value }),
      readFileSync: () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      existsSync: (target) => String(target) === '/Applications/Codex.app'
    },
    processObj: {
      platform: 'darwin',
      pid: 999,
      kill: () => {
        throw new Error('should not kill');
      }
    },
    spawnSync: () => ({
      status: 0,
      stdout: ''
    }),
    spawn: (command, args, options) => {
      launches.push({ command, args, options });
      return { unref: () => {} };
    }
  });

  const result = service.restartDetectedDesktopClient('codex');

  assert.equal(result.detected, false);
  assert.equal(result.launched, true);
  assert.equal(result.usedInstalledPath, true);
  assert.equal(launches[0].command, 'open');
  assert.deepEqual(launches[0].args, ['-a', '/Applications/Codex.app']);
  assert.equal(writes[0].value.includes('/Applications/Codex.app'), true);
});
