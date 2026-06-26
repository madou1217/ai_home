const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createModelUsageScanScheduler,
  normalizeModelUsageScanConfig
} = require('../lib/usage/model-usage-scheduler');

test('model usage scan scheduler normalizes safe defaults', () => {
  assert.deepEqual(normalizeModelUsageScanConfig({
    startDelayMs: -1,
    intervalMs: 10
  }), {
    enabled: true,
    startDelayMs: 5000,
    intervalMs: 600000
  });

  assert.deepEqual(normalizeModelUsageScanConfig({
    enabled: false,
    startDelayMs: 0,
    intervalMs: 90000
  }), {
    enabled: false,
    startDelayMs: 0,
    intervalMs: 90000
  });
});

test('model usage scan scheduler runs startup and interval scans without overlap', async () => {
  const timeouts = [];
  const intervals = [];
  const cleared = [];
  const calls = [];
  const logs = [];

  const scheduler = createModelUsageScanScheduler({
    config: {
      startDelayMs: 25,
      intervalMs: 90000
    },
    modelUsageService: {
      syncPricingIfStale: async () => {
        calls.push('pricing');
      },
      scan: () => {
        calls.push('scan');
        return { files: 1, records: 2 };
      }
    },
    setTimeoutFn: (fn, ms) => {
      const timer = { fn, ms, unrefCalled: false, unref() { this.unrefCalled = true; } };
      timeouts.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => cleared.push(timer),
    setIntervalFn: (fn, ms) => {
      const timer = { fn, ms, unrefCalled: false, unref() { this.unrefCalled = true; } };
      intervals.push(timer);
      return timer;
    },
    clearIntervalFn: (timer) => cleared.push(timer),
    logInfo: (line) => logs.push(line)
  });

  const started = scheduler.start();
  assert.equal(started.running, true);
  assert.equal(started.enabled, true);
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].ms, 25);
  assert.equal(timeouts[0].unrefCalled, true);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 90000);
  assert.equal(intervals[0].unrefCalled, true);

  await timeouts[0].fn();
  assert.deepEqual(calls, ['scan', 'pricing']);
  assert.equal(scheduler.getState().scanCount, 1);
  assert.equal(logs.some((line) => line.includes('startup')), true);

  await intervals[0].fn();
  assert.deepEqual(calls, ['scan', 'pricing', 'scan', 'pricing']);
  assert.equal(scheduler.getState().scanCount, 2);

  scheduler.stop();
  assert.equal(cleared.includes(timeouts[0]), true);
  assert.equal(cleared.includes(intervals[0]), true);
  assert.equal(scheduler.getState().running, false);
});

test('model usage scan scheduler reports already running instead of overlapping scans', async () => {
  let releaseScan;
  const scheduler = createModelUsageScanScheduler({
    modelUsageService: {
      scan: () => new Promise((resolve) => {
        releaseScan = () => resolve({ files: 1 });
      })
    }
  });

  const first = scheduler.runScanNow('first');
  const second = await scheduler.runScanNow('second');
  assert.deepEqual(second, { ok: false, skipped: true, reason: 'already_running' });

  releaseScan();
  const firstResult = await first;
  assert.deepEqual(firstResult, { ok: true, result: { files: 1 } });
  assert.equal(scheduler.getState().scanCount, 1);
});

test('model usage scan scheduler keeps scan failures best effort', async () => {
  const warnings = [];
  const scheduler = createModelUsageScanScheduler({
    modelUsageService: {
      scan: () => {
        const error = new Error('model_usage_db_unavailable');
        error.code = 'model_usage_db_unavailable';
        throw error;
      }
    },
    logWarn: (line) => warnings.push(line)
  });

  const result = await scheduler.runScanNow('manual');
  assert.deepEqual(result, { ok: false, error: 'model_usage_db_unavailable' });
  assert.equal(scheduler.getState().lastError, 'model_usage_db_unavailable');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes('manual'), true);
});

test('model usage scan scheduler does not let pricing failures block scans', async () => {
  const scheduler = createModelUsageScanScheduler({
    modelUsageService: {
      syncPricingIfStale: async () => {
        throw new Error('pricing_timeout');
      },
      scan: () => ({ files: 1, records: 2 })
    }
  });

  const result = await scheduler.runScanNow('manual');
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, { files: 1, records: 2 });
  assert.equal(scheduler.getState().scanCount, 1);
  assert.deepEqual(scheduler.getState().lastResult.pricing, {
    ok: false,
    error: 'pricing_timeout'
  });
});
