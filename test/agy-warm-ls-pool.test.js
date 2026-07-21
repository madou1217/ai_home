const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createWriterLifecycleCoordinator,
  entrySupportsModel,
  warmSupportsModel
} = require('../lib/server/agy-warm-ls-pool');

function createDeferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test('entrySupportsModel: no entry never supports', () => {
  assert.equal(entrySupportsModel(null, 'gemini-3-pro'), false);
  assert.equal(entrySupportsModel(undefined, ''), false);
});

test('entrySupportsModel: empty requested model reuses the warm session model', () => {
  assert.equal(entrySupportsModel({ model: 'gemini-3-pro' }, ''), true);
  assert.equal(entrySupportsModel({ model: '' }, ''), true);
});

test('entrySupportsModel: matching model uses warm fast path', () => {
  assert.equal(entrySupportsModel({ model: 'gemini-3-pro' }, 'gemini-3-pro'), true);
});

test('entrySupportsModel: model switch (or legacy entry without model) forces cold spawn', () => {
  assert.equal(entrySupportsModel({ model: 'gemini-3-pro' }, 'claude-sonnet-4-6'), false);
  // 旧暖机条目没记录模型：请求显式模型时宁可冷启动一次，之后条目带模型自愈。
  assert.equal(entrySupportsModel({ model: '' }, 'claude-sonnet-4-6'), false);
});

test('warmSupportsModel: unknown account has no live warm entry', () => {
  assert.equal(warmSupportsModel('no-such-account', 'gemini-3-pro'), false);
});

test('writer lifecycle shares model-switch quiescence and lets only the final generation reconcile', async () => {
  const poll = createDeferred();
  let oldWriterAlive = true;
  const terminated = [];
  const lifecycle = createWriterLifecycleCoordinator({
    isWriterAlive: (writer) => writer.pid !== 101 || oldWriterAlive,
    terminateWriter: (writer, reason) => terminated.push({ pid: writer.pid, reason }),
    waitForPoll: () => poll.promise
  });
  const accountRef = 'acct_model_switch';
  const oldLease = lifecycle.reserve(accountRef);
  lifecycle.activate(oldLease, { pid: 101 });
  const nextLease = lifecycle.reserve(accountRef);

  const firstQuiescence = lifecycle.quiesce(accountRef, {
    lease: oldLease,
    writer: { pid: 101 },
    reason: 'model-switch'
  });
  const lastLease = lifecycle.reserve(accountRef);
  const joinedQuiescence = lifecycle.quiesce(accountRef, {
    lease: oldLease,
    writer: { pid: 101 },
    reason: 'model-switch'
  });

  assert.equal(joinedQuiescence, firstQuiescence);
  assert.deepEqual(terminated, [{ pid: 101, reason: 'model-switch' }]);
  assert.equal(lifecycle.hasWriter(accountRef), true);

  oldWriterAlive = false;
  assert.equal(lifecycle.release(oldLease), false);
  poll.resolve();
  await firstQuiescence;

  lifecycle.activate(nextLease, { pid: 102 });
  lifecycle.activate(lastLease, { pid: 103 });
  assert.equal(lifecycle.release(nextLease), false);
  assert.equal(lifecycle.release(lastLease), true);
  assert.equal(lifecycle.hasWriter(accountRef), false);
});

test('writer lifecycle never lets a delayed old onExit supersede the newer final writer', async () => {
  const poll = createDeferred();
  const alive = new Set([301]);
  const lifecycle = createWriterLifecycleCoordinator({
    isWriterAlive: (writer) => alive.has(writer.pid),
    terminateWriter() {},
    waitForPoll: () => poll.promise
  });
  const accountRef = 'acct_delayed_old_exit';
  const oldLease = lifecycle.reserve(accountRef);
  lifecycle.activate(oldLease, { pid: 301 });
  const nextLease = lifecycle.reserve(accountRef);
  const quiescence = lifecycle.quiesce(accountRef, {
    lease: oldLease,
    writer: { pid: 301 },
    reason: 'model-switch'
  });

  alive.delete(301);
  poll.resolve();
  await quiescence;

  lifecycle.activate(nextLease, { pid: 302 });
  assert.equal(lifecycle.release(nextLease), true);
  assert.equal(lifecycle.release(oldLease), false);
});

for (const reason of ['idle', 'over-cap', 'send-failure-fallback']) {
  test(`writer lifecycle keeps ${reason} eviction visible until the PID exits`, async () => {
    const poll = createDeferred();
    let writerAlive = true;
    const lifecycle = createWriterLifecycleCoordinator({
      isWriterAlive: () => writerAlive,
      terminateWriter() {},
      waitForPoll: () => poll.promise
    });
    const accountRef = `acct_${reason}`;
    const lease = lifecycle.reserve(accountRef);
    lifecycle.activate(lease, { pid: 201 });

    const quiescence = lifecycle.quiesce(accountRef, {
      lease,
      writer: { pid: 201 },
      reason
    });

    assert.equal(lifecycle.isQuiescing(accountRef), true);
    assert.equal(lifecycle.hasWriter(accountRef), true);

    writerAlive = false;
    assert.equal(lifecycle.release(lease), true);
    assert.equal(lifecycle.hasWriter(accountRef), true);
    poll.resolve();
    await quiescence;

    assert.equal(lifecycle.isQuiescing(accountRef), false);
    assert.equal(lifecycle.hasWriter(accountRef), false);
  });
}
