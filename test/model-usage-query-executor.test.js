'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  createModelUsageQueryExecutor
} = require('../lib/usage/model-usage-query-executor');

const WORKER_FIXTURE = path.join(__dirname, 'fixtures', 'model-usage-query-worker.fixture.js');

test('model usage query executor bounds parallel worker threads', async (t) => {
  const executor = createModelUsageQueryExecutor({
    workerPath: WORKER_FIXTURE,
    concurrency: 2,
    queueLimit: 8,
    timeoutMs: 2_000
  });
  t.after(() => executor.close());
  const counters = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);

  const results = await Promise.all(Array.from({ length: 4 }, () => (
    executor.execute('getStats', { counters, delayMs: 50 })
  )));

  assert.equal(Atomics.load(new Int32Array(counters), 1), 2);
  assert.equal(new Set(results.map((result) => result.threadId)).size, 2);
  assert.deepEqual(executor.getState(), {
    concurrency: 2,
    queueLimit: 8,
    timeoutMs: 2_000,
    workers: 2,
    active: 0,
    queued: 0,
    closed: false
  });
});

test('model usage query executor rejects overload instead of growing without bound', async (t) => {
  const executor = createModelUsageQueryExecutor({
    workerPath: WORKER_FIXTURE,
    concurrency: 1,
    queueLimit: 1,
    timeoutMs: 2_000
  });
  t.after(() => executor.close());
  const counters = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const first = executor.execute('getStats', { counters, delayMs: 50 });
  const second = executor.execute('getStats', { counters, delayMs: 50 });

  await assert.rejects(
    executor.execute('getStats', { counters, delayMs: 50 }),
    (error) => error && error.code === 'model_usage_query_queue_full'
  );
  await Promise.all([first, second]);
});

test('model usage query executor enforces the response-time budget', async (t) => {
  const executor = createModelUsageQueryExecutor({
    workerPath: WORKER_FIXTURE,
    concurrency: 1,
    timeoutMs: 20
  });
  t.after(() => executor.close());
  const counters = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);

  await assert.rejects(
    executor.execute('getStats', { counters, delayMs: 100 }),
    (error) => error && error.code === 'model_usage_query_timeout'
  );
});
