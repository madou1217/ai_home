'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MIN_FRP_RECONCILE_INTERVAL_MS,
  startFrpConfigReconcileLoop
} = require('../lib/cli/services/fabric/frp-config-reconcile-loop');

test('FRP reconcile loop runs immediately, stays single-flight, and stops cleanly', async () => {
  let intervalCallback = null;
  let intervalMs = 0;
  let cleared = false;
  let calls = 0;
  let finishFirst;
  const first = new Promise((resolve) => {
    finishFirst = resolve;
  });
  const loop = startFrpConfigReconcileLoop({
    aiHomeDir: '/tmp/aih',
    intervalMs: 1
  }, {
    reconcileAihFrpConfig: async (options) => {
      calls += 1;
      assert.deepEqual(options, { aiHomeDir: '/tmp/aih' });
      if (calls === 1) await first;
      return { ok: true, total: 1, reconciled: 0, unchanged: 1, failures: [] };
    },
    setInterval(callback, delayMs) {
      intervalCallback = callback;
      intervalMs = delayMs;
      return { unref() {} };
    },
    clearInterval() {
      cleared = true;
    }
  });

  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(intervalMs, MIN_FRP_RECONCILE_INTERVAL_MS);
  intervalCallback();
  await Promise.resolve();
  assert.equal(calls, 1);
  finishFirst();
  await loop.run();
  assert.equal(calls, 1);

  await loop.run();
  assert.equal(calls, 2);
  loop.stop();
  assert.equal(cleared, true);
  assert.deepEqual(await loop.run(), { ok: true, skipped: true });
});

test('FRP reconcile loop degrades safely when configuration management is unavailable', async () => {
  const loop = startFrpConfigReconcileLoop({}, {});
  assert.deepEqual(await loop.run(), { ok: true, skipped: true });
  loop.stop();
});
