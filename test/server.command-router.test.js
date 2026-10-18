const test = require('node:test');
const assert = require('node:assert/strict');
const { runServerCommandRouter } = require('../lib/cli/commands/server-router');
const { SHUTDOWN_GRACE_MS } = require('../lib/server/inference-drain');

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
    options: { waitForReady: false, readyTimeoutMs: 7000, backgroundLivenessGraceMs: 400 }
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
    options: { waitForReady: false, readyTimeoutMs: 7000, gracefulStopWaitMs: SHUTDOWN_GRACE_MS, backgroundLivenessGraceMs: 400 }
  }]);
  assert.equal(exitCode, 0);
});

test('server router stop awaits an async daemon stop before reporting the result', async () => {
  const logs = [];
  const originalLog = console.log;
  let exitCode = null;
  console.log = (...parts) => logs.push(parts.join(' '));
  try {
    runServerCommandRouter(['server', 'stop'], {
      processImpl: { exit(code) { exitCode = code; } },
      showServerUsage() {},
      getServerDaemonStatus() { return { running: false }; },
      getServerAutostartStatus() { return { supported: false }; },
      installServerAutostart() {},
      uninstallServerAutostart() {},
      // daemon 的 stop 已是 async（不再用 Atomics.wait 冻结事件循环）：不 await 会读到
      // Promise.stopped === undefined，真停掉了也报 "stop skipped (not_running)"。
      stopServerDaemon: async () => ({ stopped: true, pid: 45678, forced: false }),
      startServerDaemon: async () => ({}),
      restartServerDaemon: async () => ({}),
      parseServerEnvArgs() { return {}; },
      parseServerServeArgs() { return {}; },
      startLocalServer: async () => ({}),
      parseServerSyncArgs() { return {}; },
      syncCodexAccountsToServer: async () => ({})
    });
    await flushAsync();
  } finally {
    console.log = originalLog;
  }

  const output = logs.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
  assert.ok(output.some((line) => line.includes('server stopped (pid=45678)')), output.join('\n'));
  assert.ok(!output.some((line) => line.includes('stop skipped')), output.join('\n'));
  assert.equal(exitCode, 0);
});
