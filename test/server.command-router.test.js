const test = require('node:test');
const assert = require('node:assert/strict');
const { runServerCommandRouter } = require('../lib/cli/commands/server-router');

function flushAsync() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('server router start requests fast background launch without foreground ready wait', async () => {
  const startCalls = [];
  let exitCode = null;

  runServerCommandRouter(['server', 'start'], {
    processImpl: { exit(code) { exitCode = code; } },
    showServerUsage() {},
    getServerDaemonStatus() { return { running: false }; },
    getServerAutostartStatus() { return { supported: false }; },
    installServerAutostart() {},
    uninstallServerAutostart() {},
    stopServerDaemon() { return { stopped: false, reason: 'not_running' }; },
    startServerDaemon: async (args, options) => {
      startCalls.push({ args, options });
      return { alreadyRunning: false, started: true, pid: 12345 };
    },
    parseServerEnvArgs() { return {}; },
    parseServerServeArgs() { return {}; },
    startLocalServer: async () => ({}),
    parseServerSyncArgs() { return {}; },
    syncCodexAccountsToServer: async () => ({})
  });

  await flushAsync();
  assert.deepEqual(startCalls, [{
    args: [],
    options: { waitForReady: false, readyTimeoutMs: 7000 }
  }]);
  assert.equal(exitCode, 0);
});

test('server router restart delegates to daemon restart orchestration', async () => {
  const restartCalls = [];
  let exitCode = null;

  runServerCommandRouter(['server', 'restart'], {
    processImpl: { exit(code) { exitCode = code; } },
    showServerUsage() {},
    getServerDaemonStatus() { return { running: false }; },
    getServerAutostartStatus() { return { supported: false }; },
    installServerAutostart() {},
    uninstallServerAutostart() {},
    stopServerDaemon() { return { stopped: false, reason: 'not_used' }; },
    startServerDaemon: async () => ({}),
    restartServerDaemon: async (args, options) => {
      restartCalls.push({ args, options });
      return {
        alreadyRunning: false,
        started: true,
        pid: 34567,
        stoppedForRestart: { stopped: true, pid: 23456, forced: true }
      };
    },
    parseServerEnvArgs() { return {}; },
    parseServerServeArgs() { return {}; },
    startLocalServer: async () => ({}),
    parseServerSyncArgs() { return {}; },
    syncCodexAccountsToServer: async () => ({})
  });

  await flushAsync();
  assert.deepEqual(restartCalls, [{
    args: [],
    options: { waitForReady: false, readyTimeoutMs: 7000, gracefulStopWaitMs: 500 }
  }]);
  assert.equal(exitCode, 0);
});
