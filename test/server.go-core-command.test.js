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

test('server start leaves Go Core supervision to the long-lived server process', async () => {
  let startOptions;
  const deps = baseDeps({
    serverDaemon: {
      ...baseDeps().serverDaemon,
      start: async (_args, options) => {
        startOptions = options;
        return { started: true, ready: true, pid: 1001 };
      }
    }
  });

  const code = await runServerCommand(['server', 'start'], deps);

  assert.equal(code, 0);
  assert.deepEqual(startOptions, { waitForReady: false, readyTimeoutMs: 7000 });
});

test('server stop only stops the Node host, which stops its own Go Core child', async () => {
  const calls = [];
  const deps = baseDeps({
    serverDaemon: {
      ...baseDeps().serverDaemon,
      stop: () => { calls.push('node'); return { stopped: true, pid: 1001 }; }
    }
  });

  const code = await runServerCommand(['server', 'stop'], deps);

  assert.equal(code, 0);
  assert.deepEqual(calls, ['node']);
});
