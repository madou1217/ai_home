'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { CodexThreadRelease } = require('../lib/server/codex-thread-release');

const closed = (threadId = 'thread-1') => ({ method: 'thread/closed', params: { threadId } });
const nextTask = () => new Promise((resolve) => setImmediate(resolve));

test('unsubscribe receipt waits for the exact writer closure and deduplicates concurrent release', async () => {
  let requests = 0;
  const release = new CodexThreadRelease({ request: async () => {
    requests += 1;
    return { status: 'unsubscribed' };
  }});
  const result = release.release('thread-1');
  assert.equal(release.release('thread-1'), result);
  let finished = false;
  result.then(() => { finished = true; });
  await nextTask();
  release.observe(closed('other-thread'));
  await nextTask();
  assert.equal(finished, false);
  release.observe(closed());
  assert.deepEqual(await result, { released: true, status: 'unsubscribed' });
  assert.equal(requests, 1);
});

test('native closure before its RPC receipt still waits for the receipt', async () => {
  let acknowledge;
  const release = new CodexThreadRelease({
    request: () => new Promise((resolve) => { acknowledge = resolve; })
  });
  const result = release.release('thread-1');
  await nextTask();
  release.observe(closed());
  let finished = false;
  result.then(() => { finished = true; });
  await nextTask();
  assert.equal(finished, false);
  acknowledge({ status: 'unsubscribed' });
  assert.deepEqual(await result, { released: true, status: 'unsubscribed' });
});

for (const status of ['notLoaded', 'notSubscribed']) {
  test(`${status} releases only this connection without waiting for another owner's thread`, async () => {
    const release = new CodexThreadRelease({ request: async () => ({ status }) });
    assert.deepEqual(await release.release('thread-1'), { released: true, status });
  });
}

test('disconnect settles pending release and ignores late receipts', async () => {
  let acknowledge;
  const failures = [];
  const release = new CodexThreadRelease({
    request: () => new Promise((resolve) => { acknowledge = resolve; }),
    reportFailure: (failure) => failures.push(failure)
  });
  const result = release.release('thread-1');
  await nextTask();
  release.disconnect();
  assert.deepEqual(await result, { released: false, reason: 'codex_app_server_disconnected' });
  acknowledge({ status: 'unsubscribed' });
  release.observe(closed());
  await nextTask();
  assert.equal(failures.length, 1);
  assert.equal(release.pending.size, 0);
});

test('release timeout is bounded and observable without rewriting a completed turn', async () => {
  const failures = [];
  const release = new CodexThreadRelease({
    request: async () => ({ status: 'unsubscribed' }), timeoutMs: 5,
    reportFailure: (failure) => failures.push(failure)
  });
  assert.deepEqual(await release.release('thread-1'), { released: false, reason: 'codex_thread_release_timeout' });
  assert.equal(failures[0].threadId, 'thread-1');
  assert.equal(release.pending.size, 0);
});

test('invalid release receipts and request failures never certify writer closure', async () => {
  for (const request of [async () => ({}), async () => { throw Object.assign(new Error('offline'), { code: 'offline' }); }]) {
    const release = new CodexThreadRelease({ request });
    const result = await release.release('thread-1');
    assert.equal(result.released, false);
    assert.ok(result.reason);
  }
});
