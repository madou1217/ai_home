'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { runServerCommand } = require('../lib/server/command-handler');

function baseDeps(overrides = {}) {
  return {
    showServerUsage() {},
    serverDaemon: {
      start: async () => ({ started: true, ready: true, pid: 1001, baseUrl: 'http://127.0.0.1:9527/v1' }),
      restart: async () => ({ started: true, ready: true, pid: 1001, baseUrl: 'http://127.0.0.1:9527/v1' }),
      stop: () => ({ stopped: true, pid: 1001 }),
      status: () => ({ running: false }),
      autostartStatus: () => ({ supported: false })
    },
    parseServerEnvArgs: () => ({}),
    parseServerServeArgs: () => ({}),
    parseServerSyncArgs: () => ({}),
    startLocalServer: async () => ({}),
    syncCodexAccountsToServer: async () => ({ dryRun: true, failed: 0 }),
    ...overrides
  };
}

test('启用 Go Core 时 server start 只通过 Node daemon 的显式 opt-in 监督能力', async () => {
  let startOptions;
  const deps = baseDeps({
    serverDaemon: {
      ...baseDeps().serverDaemon,
      goCoreStatus: () => ({ enabled: true, state: 'stopped' }),
      startGoCore: async () => ({ enabled: true, state: 'ready' }),
      start: async (_args, options) => {
        startOptions = options;
        return { started: true, ready: true, pid: 1001, goCore: { state: 'ready' } };
      }
    }
  });

  const code = await runServerCommand(['server', 'start'], deps);

  assert.equal(code, 0);
  assert.deepEqual(startOptions, {
    waitForReady: false,
    readyTimeoutMs: 7000,
    startGoCore: true
  });
});

test('server stop 先停止 Go Core，再停止 Node 公开宿主', async () => {
  const calls = [];
  const deps = baseDeps({
    serverDaemon: {
      ...baseDeps().serverDaemon,
      goCoreStatus: () => ({ enabled: true, state: 'ready' }),
      stopGoCore: async () => { calls.push('go'); },
      stop: () => { calls.push('node'); return { stopped: true, pid: 1001 }; }
    }
  });

  const code = await runServerCommand(['server', 'stop'], deps);

  assert.equal(code, 0);
  assert.deepEqual(calls, ['go', 'node']);
});

test('Go Core 启动失败时命令返回失败而不伪装成健康', async () => {
  const deps = baseDeps({
    serverDaemon: {
      ...baseDeps().serverDaemon,
      goCoreStatus: () => ({ enabled: true, state: 'stopped' }),
      start: async () => ({
        started: true,
        ready: true,
        pid: 1001,
        goCoreFailed: true,
        goCore: { state: 'failed', error: 'go_core_not_ready' }
      })
    }
  });

  const code = await runServerCommand(['server', 'start'], deps);

  assert.equal(code, 1);
});
