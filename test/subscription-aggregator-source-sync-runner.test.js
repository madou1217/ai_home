'use strict';

// 订阅源异步同步：start 立刻返回、每个源各自出结果、全局并发上限、同源单飞、一个源失败不影响其它源。

const assert = require('node:assert/strict');
const test = require('node:test');

const { SourceSyncRunner } = require('../lib/cli/services/toolkit/subscription-aggregator/source-sync-runner');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

/** 每个源一个可控的拉取：测试决定它何时、以什么结果结束。 */
function controllableService() {
  const pending = new Map();
  const calls = [];
  let active = 0;
  let peak = 0;
  return {
    calls,
    get peak() { return peak; },
    syncSource(id) {
      calls.push(id);
      active += 1;
      peak = Math.max(peak, active);
      const gate = deferred();
      pending.set(id, gate);
      return gate.promise.finally(() => { active -= 1; });
    },
    finish(id, result) {
      pending.get(id).resolve(result);
    },
    fail(id, error) {
      pending.get(id).reject(error);
    }
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('start returns a queued job immediately without waiting for any fetch', () => {
  const service = controllableService();
  const runner = new SourceSyncRunner({ service, concurrency: 2 });
  const started = runner.start([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }]);
  assert.equal(started.ok, true);
  assert.match(started.job.id, /^sync_[0-9a-f]{12}$/);
  assert.deepEqual(started.job.counts, { total: 3, done: 0, failed: 0, succeeded: 0 });
  assert.deepEqual(started.job.items.map((item) => item.name), ['A', 'B', 'C']);
  assert.deepEqual(runner.start([]), { ok: false, error: 'subscription_source_required' });
});

test('each source reports on its own and a 403 does not fail its neighbours', async () => {
  const service = controllableService();
  const events = [];
  const runner = new SourceSyncRunner({ service, concurrency: 4 });
  runner.onChange((event) => events.push(event));
  const { job } = runner.start([{ id: 'ok', name: '机场A' }, { id: 'blocked', name: '机场B' }]);
  await settle();
  service.finish('blocked', { ok: false, error: 'subscription_http_error', message: 'subscription_http_403' });
  await settle();
  // 第二个源还没结束时，第一个源的失败已经单独推出去了。
  const midway = runner.getJob(job.id);
  assert.equal(midway.status, 'running');
  assert.deepEqual(midway.items.map((item) => [item.sourceId, item.state]), [['ok', 'running'], ['blocked', 'failed']]);
  assert.equal(midway.items[1].message, 'subscription_http_403');

  service.finish('ok', { ok: true, count: 80 });
  await settle();
  const finished = runner.getJob(job.id);
  assert.equal(finished.status, 'partial');
  assert.deepEqual(finished.counts, { total: 2, done: 2, failed: 1, succeeded: 1 });
  assert.equal(finished.items[0].count, 80);
  assert.ok(finished.finishedAt);
  assert.ok(events.every((event) => event.type === 'job' && event.job.id === job.id));
  assert.equal(events.at(-1).job.status, 'partial');
  assert.deepEqual(runner.snapshot().sources.blocked.state, 'failed');
});

test('concurrency is a global cap shared across jobs', async () => {
  const service = controllableService();
  const runner = new SourceSyncRunner({ service, concurrency: 2 });
  runner.start([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  runner.start([{ id: 'd' }, { id: 'e' }]);
  await settle();
  assert.deepEqual(service.calls, ['a', 'b'], 'only two fetches run at a time across both jobs');
  service.finish('a', { ok: true });
  await settle();
  assert.deepEqual(service.calls, ['a', 'b', 'c']);
  for (const id of ['b', 'c']) service.finish(id, { ok: true });
  await settle();
  for (const id of ['d', 'e']) service.finish(id, { ok: true });
  await settle();
  assert.equal(service.peak, 2);
});

test('the same source is fetched once even when two jobs ask for it', async () => {
  const service = controllableService();
  const runner = new SourceSyncRunner({ service, concurrency: 4 });
  const all = runner.start([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]).job;
  await settle();
  // 「全部同步」在跑时再点单个源：复用进行中的任务，不新建、不重拉。
  const one = runner.startOne({ id: 'a', name: 'A' });
  assert.deepEqual([one.reused, one.job.id], [true, all.id]);
  const other = runner.start([{ id: 'a', name: 'A' }]).job;
  service.finish('a', { ok: true, count: 3 });
  service.finish('b', { ok: true, count: 1 });
  await settle();
  assert.deepEqual(service.calls, ['a', 'b']);
  assert.equal(runner.getJob(other.id).status, 'succeeded', 'the second job shares the first fetch result');
  assert.equal(runner.getJob(other.id).items[0].count, 3);
  // 结束后再点一次会真的重新拉。
  runner.startOne({ id: 'a', name: 'A' });
  await settle();
  assert.deepEqual(service.calls, ['a', 'b', 'a']);
  service.finish('a', { ok: true });
});

test('a throwing fetch still releases the source instead of leaving it stuck as syncing', async () => {
  const service = controllableService();
  const runner = new SourceSyncRunner({ service, concurrency: 1 });
  const { job } = runner.start([{ id: 'a' }, { id: 'b' }]);
  await settle();
  service.fail('a', Object.assign(new Error('boom'), { code: 'subscription_fetch_failed' }));
  await settle();
  assert.deepEqual(service.calls, ['a', 'b'], 'the queue moves on after a thrown error');
  service.finish('b', { ok: true });
  await settle();
  const finished = runner.getJob(job.id);
  assert.deepEqual(finished.items.map((item) => [item.state, item.error]), [['failed', 'subscription_fetch_failed'], ['succeeded', '']]);
  assert.equal(runner.startOne({ id: 'a' }).reused, undefined, 'a new sync can start for the failed source');
  await settle();
  service.finish('a', { ok: true });
});

test('a throwing listener cannot break the sync', async () => {
  const service = controllableService();
  const runner = new SourceSyncRunner({ service });
  runner.onChange(() => { throw new Error('listener boom'); });
  const { job } = runner.start([{ id: 'a' }]);
  await settle();
  service.finish('a', { ok: true });
  await settle();
  assert.equal(runner.getJob(job.id).status, 'succeeded');
});

test('finished jobs expire after the retention window but active jobs stay', async () => {
  let now = 1000;
  const service = controllableService();
  const runner = new SourceSyncRunner({ service, now: () => now, retentionMs: 50 });
  const done = runner.start([{ id: 'a' }]).job;
  await settle();
  service.finish('a', { ok: true });
  await settle();
  const running = runner.start([{ id: 'b' }]).job;
  now += 100;
  const { jobs } = runner.snapshot();
  assert.deepEqual(jobs.map((job) => job.id), [running.id]);
  assert.equal(runner.getJob(done.id), null);
  await settle();
  service.finish('b', { ok: true });
});
