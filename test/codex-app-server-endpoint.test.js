'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  waitForAppServerReady
} = require('../lib/server/codex-app-server-endpoint');

test('app-server readiness returns as soon as readyz succeeds', async () => {
  let livenessChecks = 0;

  await waitForAppServerReady(9527, 'aih-codexapp-test', {
    checkReadyz: async () => true,
    hasRunSession: () => {
      livenessChecks += 1;
      return true;
    }
  });

  assert.equal(livenessChecks, 0);
});

test('app-server readiness fails immediately when the tmux process exits', async () => {
  let delayCalls = 0;

  await assert.rejects(
    waitForAppServerReady(9527, 'aih-codexapp-test', {
      checkReadyz: async () => false,
      hasRunSession: () => false,
      delay: async () => {
        delayCalls += 1;
      },
      logPath: '/tmp/codex-app-server.log'
    }),
    (error) => error.code === 'codex_app_server_process_exited'
      && error.message.includes('/tmp/codex-app-server.log')
  );
  assert.equal(delayCalls, 0);
});

test('app-server readiness preserves the bounded timeout for a live process', async () => {
  let timestamp = 0;

  await assert.rejects(
    waitForAppServerReady(9527, 'aih-codexapp-test', {
      timeoutMs: 2,
      pollIntervalMs: 0,
      now: () => timestamp++,
      checkReadyz: async () => false,
      hasRunSession: () => true,
      delay: async () => {}
    }),
    (error) => error.code === 'codex_app_server_not_ready'
      && error.message.includes('2ms')
  );
});
