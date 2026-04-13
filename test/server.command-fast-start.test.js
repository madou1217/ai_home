'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runServerCommand } = require('../lib/server/command-handler');
const { runServerCommandRouter } = require('../lib/cli/commands/server-router');

test('runServerCommand starts daemon in non-blocking mode', async () => {
  const calls = [];
  const code = await runServerCommand(['server', 'start'], {
    showServerUsage() {},
    serverDaemon: {
      start: async (rawServeArgs, startOptions) => {
        calls.push({ rawServeArgs, startOptions });
        return { alreadyRunning: false, started: true, pid: 1234 };
      },
      stop: () => ({ stopped: false, reason: 'not_running' }),
      status: () => ({ running: false }),
      autostartStatus: () => ({ supported: false })
    },
    parseServerEnvArgs: () => ({}),
    parseServerServeArgs: () => ({}),
    parseServerSyncArgs: () => ({}),
    startLocalServer: async () => ({}),
    syncCodexAccountsToServer: async () => ({ dryRun: true, failed: 0 })
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, [{
    rawServeArgs: [],
    startOptions: { waitForReady: false, readyTimeoutMs: 7000 }
  }]);
});

test('runServerCommand restarts daemon in non-blocking mode after stop', async () => {
  const calls = [];
  const code = await runServerCommand(['server', 'restart', '--host', '0.0.0.0'], {
    showServerUsage() {},
    serverDaemon: {
      start: async (rawServeArgs, startOptions) => {
        calls.push({ rawServeArgs, startOptions });
        return { alreadyRunning: false, started: true, pid: 5678 };
      },
      stop: (stopOptions) => {
        calls.push({ stopOptions });
        return { stopped: true, pid: 1111 };
      },
      status: () => ({ running: false }),
      autostartStatus: () => ({ supported: false })
    },
    parseServerEnvArgs: () => ({}),
    parseServerServeArgs: () => ({}),
    parseServerSyncArgs: () => ({}),
    startLocalServer: async () => ({}),
    syncCodexAccountsToServer: async () => ({ dryRun: true, failed: 0 })
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, [
    { stopOptions: { gracefulStopWaitMs: 500 } },
    {
      rawServeArgs: ['--host', '0.0.0.0'],
      startOptions: { waitForReady: false, readyTimeoutMs: 7000 }
    }
  ]);
});

test('runServerCommandRouter starts daemon in non-blocking mode', () => {
  const calls = [];
  let exitCode = null;
  runServerCommandRouter(['server', 'start'], {
    processImpl: {
      exit(code) {
        exitCode = code;
      }
    },
    showServerUsage() {},
    getServerDaemonStatus: () => ({ running: false }),
    getServerAutostartStatus: () => ({ supported: false }),
    installServerAutostart() {},
    uninstallServerAutostart() {},
    stopServerDaemon: () => ({ stopped: false, reason: 'not_running' }),
    startServerDaemon: async (rawServeArgs, startOptions) => {
      calls.push({ rawServeArgs, startOptions });
      return { alreadyRunning: false, started: true, pid: 9012 };
    },
    parseServerEnvArgs: () => ({}),
    parseServerServeArgs: () => ({}),
    startLocalServer: async () => ({}),
    parseServerSyncArgs: () => ({}),
    syncCodexAccountsToServer: async () => ({ dryRun: true, failed: 0 })
  });

  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(exitCode, 0);
      assert.deepEqual(calls, [{
        rawServeArgs: [],
        startOptions: { waitForReady: false, readyTimeoutMs: 7000 }
      }]);
      resolve();
    }, 0);
  });
});

test('runServerCommandRouter restarts daemon in non-blocking mode', () => {
  const calls = [];
  let exitCode = null;
  runServerCommandRouter(['server', 'restart'], {
    processImpl: {
      exit(code) {
        exitCode = code;
      }
    },
    showServerUsage() {},
    getServerDaemonStatus: () => ({ running: false }),
    getServerAutostartStatus: () => ({ supported: false }),
    installServerAutostart() {},
    uninstallServerAutostart() {},
    stopServerDaemon: (stopOptions) => {
      calls.push({ stopOptions });
      return { stopped: true, pid: 3141 };
    },
    startServerDaemon: async (rawServeArgs, startOptions) => {
      calls.push({ rawServeArgs, startOptions });
      return { alreadyRunning: false, started: true, pid: 2718 };
    },
    parseServerEnvArgs: () => ({}),
    parseServerServeArgs: () => ({}),
    startLocalServer: async () => ({}),
    parseServerSyncArgs: () => ({}),
    syncCodexAccountsToServer: async () => ({ dryRun: true, failed: 0 })
  });

  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(exitCode, 0);
      assert.deepEqual(calls, [
        { stopOptions: { gracefulStopWaitMs: 500 } },
        {
          rawServeArgs: [],
          startOptions: { waitForReady: false, readyTimeoutMs: 7000 }
        }
      ]);
      resolve();
    }, 0);
  });
});
