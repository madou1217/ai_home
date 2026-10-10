'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { startLocalServer } = require('../lib/server/server');
const { createProcessCapture, createServeOptions, createServerDeps, getFreePort } = require('./helpers/local-server-harness');

test('Go startup completes before session restore can block its health probe', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-go-startup-order-'));
  const processObj = createProcessCapture();
  const lifecycle = { logTimers: new Set() };
  const order = [];
  const handle = await startLocalServer(createServeOptions(await getFreePort(), { manageProcessLifecycle: false }),
    createServerDeps(root, processObj, lifecycle, {
      createGoCoreHost: () => ({
        async start() {
          order.push('go-starting');
          await new Promise(resolve => setImmediate(resolve));
          order.push('go-ready');
        },
        async stop() {},
        tryHandleHttp: async () => false,
        tryHandleUpgrade: () => false,
        isForwardingAvailable: () => false
      }),
      restorePersistentSessions: () => { order.push('session-restore'); return { restored: 0 }; }
    }));
  t.after(async () => { await handle.stop('test-cleanup'); fs.rmSync(root, { recursive: true, force: true }); });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(order.indexOf('go-ready') > order.indexOf('go-starting'));
  assert.ok(order.indexOf('session-restore') > order.indexOf('go-ready'), 'session restore started during the Go startup probe');
});
