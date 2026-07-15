const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createDesktopClientRestartService,
  extractMacAppBundlePath
} = require('../lib/cli/services/ai-cli/desktop-client-restart');
const { readJsonValue, writeJsonValue } = require('../lib/server/app-state-store');

const DESKTOP_CLIENT_PATHS_KEY = 'desktop-client-paths';

test('extractMacAppBundlePath derives .app root from executable path', () => {
  assert.equal(
    extractMacAppBundlePath('/Applications/Codex.app/Contents/MacOS/Codex'),
    '/Applications/Codex.app'
  );
});

test('desktop client restart relaunches matching macOS app bundle executable', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-desktop-restart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const killCalls = [];
  const launches = [];
  let aliveChecks = 0;
  const service = createDesktopClientRestartService({
    aiHomeDir,
    stopWaitTimeoutMs: 1000,
    stopWaitIntervalMs: 1,
    fs,
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
  const savedPaths = readJsonValue(fs, aiHomeDir, DESKTOP_CLIENT_PATHS_KEY);
  assert.equal(savedPaths.codex.macos.executablePath, '/Applications/Codex.app/Contents/MacOS/Codex');
  assert.equal(savedPaths.codex.macos.bundlePath, '/Applications/Codex.app');
});

test('desktop client restart recognizes the merged ChatGPT process as the Codex client', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chatgpt-restart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const launches = [];
  let alive = true;
  const service = createDesktopClientRestartService({
    aiHomeDir,
    stopWaitTimeoutMs: 1000,
    stopWaitIntervalMs: 1,
    fs,
    processObj: {
      platform: 'darwin',
      pid: 999,
      kill(pid, signal) {
        if (signal === 0 && !alive) throw new Error('not running');
      }
    },
    spawnSync(command) {
      if (command === 'ps') {
        return { status: 0, stdout: '123 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n' };
      }
      if (command === 'osascript') {
        alive = false;
        return { status: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected command ${command}`);
    },
    spawn(command, args) {
      launches.push({ command, args });
      return { unref() {} };
    }
  });

  const result = service.restartDetectedDesktopClient('codex');

  assert.equal(result.detected, true);
  assert.equal(result.restarted, true);
  assert.deepEqual(launches[0], { command: 'open', args: ['-a', '/Applications/ChatGPT.app'] });
  const savedPaths = readJsonValue(fs, aiHomeDir, DESKTOP_CLIENT_PATHS_KEY);
  assert.equal(savedPaths.codex.macos.executablePath, '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT');
  assert.equal(savedPaths.codex.macos.bundlePath, '/Applications/ChatGPT.app');
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
    hostHomeDir: 'C:\\Users\\madou',
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
      env: {
        PATH: 'C:\\Windows\\System32',
        HOME: 'C:\\Users\\madou\\.codex',
        USERPROFILE: 'C:\\Users\\madou\\.codex',
        HOMEDRIVE: 'C:',
        HOMEPATH: '\\Users\\madou\\.codex',
        CODEX_HOME: 'C:\\Users\\madou\\.codex',
        CODEX_SQLITE_HOME: 'C:\\Users\\madou\\.codex',
        AIH_HOST_HOME: 'C:\\Users\\madou\\.codex',
        XDG_CONFIG_HOME: 'C:\\Users\\madou\\.codex'
      },
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
  assert.equal(launches[0].options.cwd, 'C:\\Program Files\\OpenAI');
  assert.equal(launches[0].options.env.HOME, 'C:\\Users\\madou');
  assert.equal(launches[0].options.env.USERPROFILE, 'C:\\Users\\madou');
  assert.equal(launches[0].options.env.HOMEDRIVE, 'C:');
  assert.equal(launches[0].options.env.HOMEPATH, '\\Users\\madou');
  assert.equal(Object.prototype.hasOwnProperty.call(launches[0].options.env, 'CODEX_HOME'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(launches[0].options.env, 'CODEX_SQLITE_HOME'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(launches[0].options.env, 'AIH_HOST_HOME'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(launches[0].options.env, 'XDG_CONFIG_HOME'), false);
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

test('desktop client restart launches learned path when app is not running', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-desktop-restart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  writeJsonValue(fs, aiHomeDir, DESKTOP_CLIENT_PATHS_KEY, {
    codex: {
      macos: {
        clientName: 'Codex',
        executablePath: '/Applications/Codex.app/Contents/MacOS/Codex',
        bundlePath: '/Applications/Codex.app'
      }
    }
  });
  const launches = [];
  const service = createDesktopClientRestartService({
    aiHomeDir,
    fs: {
      ...fs,
      existsSync: (target) => {
        if (String(target).startsWith('/Applications/ChatGPT.app')) return false;
        return String(target) === '/Applications/Codex.app' || fs.existsSync(target);
      }
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

test('desktop client restart launches saved windows path with clean home env and cwd', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-desktop-restart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  writeJsonValue(fs, aiHomeDir, DESKTOP_CLIENT_PATHS_KEY, {
    codex: {
      windows: {
        clientName: 'Codex',
        executablePath: 'C:\\Program Files\\OpenAI\\Codex.exe'
      }
    }
  });
  const launches = [];
  const service = createDesktopClientRestartService({
    aiHomeDir,
    hostHomeDir: 'C:\\Users\\madou',
    fs: {
      ...fs,
      existsSync: () => true
    },
    processObj: {
      platform: 'win32',
      pid: 999,
      env: {
        PATH: 'C:\\Windows\\System32',
        HOME: 'C:\\Users\\madou\\.codex',
        USERPROFILE: 'C:\\Users\\madou\\.codex',
        HOMEDRIVE: 'C:',
        HOMEPATH: '\\Users\\madou\\.codex',
        CODEX_HOME: 'C:\\Users\\madou\\.codex',
        CODEX_SQLITE_HOME: 'C:\\Users\\madou\\.codex',
        AIH_HOST_HOME: 'C:\\Users\\madou\\.codex',
        XDG_CONFIG_HOME: 'C:\\Users\\madou\\.codex'
      },
      kill: () => {
        throw new Error('should not kill');
      }
    },
    spawnSync: (command) => {
      if (command === 'powershell.exe') return { status: 0, stdout: '' };
      throw new Error(`unexpected command ${command}`);
    },
    spawn: (command, args, options) => {
      launches.push({ command, args, options });
      return { unref: () => {} };
    }
  });

  const result = service.restartDetectedDesktopClient('codex');

  assert.equal(result.launched, true);
  assert.equal(result.usedSavedPath, true);
  assert.equal(launches[0].command, 'C:\\Program Files\\OpenAI\\Codex.exe');
  assert.equal(launches[0].options.cwd, 'C:\\Program Files\\OpenAI');
  assert.equal(launches[0].options.env.HOME, 'C:\\Users\\madou');
  assert.equal(launches[0].options.env.USERPROFILE, 'C:\\Users\\madou');
  assert.equal(launches[0].options.env.HOMEPATH, '\\Users\\madou');
  assert.equal(Object.prototype.hasOwnProperty.call(launches[0].options.env, 'CODEX_HOME'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(launches[0].options.env, 'AIH_HOST_HOME'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(launches[0].options.env, 'XDG_CONFIG_HOME'), false);
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

test('desktop client restart launches installed macOS app bundle when cache is missing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-desktop-restart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const launches = [];
  const service = createDesktopClientRestartService({
    aiHomeDir,
    hostHomeDir: '/Users/model',
    fs: {
      ...fs,
      existsSync: (target) => {
        if (String(target).startsWith('/Applications/ChatGPT.app')) return false;
        return String(target) === '/Applications/Codex.app' || fs.existsSync(target);
      }
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
  const savedPaths = readJsonValue(fs, aiHomeDir, DESKTOP_CLIENT_PATHS_KEY);
  assert.equal(savedPaths.codex.macos.bundlePath, '/Applications/Codex.app');
});

test('desktop client restart launches the installed merged ChatGPT bundle when cache is missing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chatgpt-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const bundlePath = '/Applications/ChatGPT.app';
  const executablePath = `${bundlePath}/Contents/MacOS/ChatGPT`;
  const launches = [];
  const service = createDesktopClientRestartService({
    aiHomeDir,
    hostHomeDir: '/Users/model',
    fs: {
      ...fs,
      existsSync(target) {
        return target === bundlePath || target === executablePath || fs.existsSync(target);
      }
    },
    processObj: { platform: 'darwin', pid: 999, kill() {} },
    spawnSync: () => ({ status: 0, stdout: '' }),
    spawn(command, args) {
      launches.push({ command, args });
      return { unref() {} };
    }
  });

  const result = service.restartDetectedDesktopClient('codex');

  assert.equal(result.launched, true);
  assert.equal(result.usedInstalledPath, true);
  assert.deepEqual(launches[0], { command: 'open', args: ['-a', bundlePath] });
  const savedPaths = readJsonValue(fs, aiHomeDir, DESKTOP_CLIENT_PATHS_KEY);
  assert.equal(savedPaths.codex.macos.executablePath, executablePath);
  assert.equal(savedPaths.codex.macos.bundlePath, bundlePath);
});
