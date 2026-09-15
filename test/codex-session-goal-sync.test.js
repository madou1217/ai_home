'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CodexSessionGoalSync } = require('../lib/server/chat-runtime/codex-session-goal-sync');

const active = { nativeThreadId: 'thread-1' };
const goal = { threadId: 'thread-1', objective: 'finish', status: 'paused' };

function fixture(options = {}) {
  const messages = [];
  const calls = [];
  const session = { policy: { lineage: { parentSessionId: 'parent' }, ...options.policy } };
  const sync = new CodexSessionGoalSync({ readSession: () => session,
    client: { async request(method, params) {
      calls.push({ method, params });
      return options.request ? options.request() : { goal };
    } },
    publish: async (message) => {
      if (options.publish) await options.publish(message);
      messages.push(message);
    }
  });
  return { sync, session, calls, messages };
}

test('goal recovery uses the supplied recovery client and awaits persistence', async () => {
  let release;
  const f = fixture({ publish: () => new Promise((resolve) => { release = resolve; }) });
  let recovered = false;
  let requested = false;
  const reading = f.sync.refresh(active, { async request(method, params) {
    assert.equal(method, 'thread/goal/get');
    assert.deepEqual(params, { threadId: 'thread-1' });
    requested = true;
    return { goal };
  } }).then(() => { recovered = true; });
  await new Promise(setImmediate);
  assert.equal(requested, true);
  assert.equal(recovered, false);
  assert.equal(f.calls.length, 0);
  release();
  await reading;
  assert.equal(f.messages[0].params.goal, goal);
  await f.sync.refresh(active);
  assert.equal(f.messages.length, 1, 'unchanged goal is not published twice');
});

test('a read started before a newer native notification cannot overwrite it', async () => {
  let release;
  const f = fixture({ request: () => new Promise((resolve) => { release = resolve; }) });
  const reading = f.sync.refresh(active);
  f.sync.observe({ type: 'session.goal.updated', payload: { goal: { ...goal, status: 'complete' } } });
  release({ goal });
  await reading;
  assert.deepEqual(f.messages, []);
});

test('a read started before a newer AIH goal cannot clear it', async () => {
  let release;
  const f = fixture({ request: () => new Promise((resolve) => { release = resolve; }) });
  const reading = f.sync.refresh(active);
  f.session.policy.contextState = { goalSource: 'aih', goal };
  release({ goal: null });
  await reading;
  assert.deepEqual(f.messages, []);
});

test('missing goal, foreign thread and malformed snapshots fail without clearing the goal', async () => {
  for (const result of [{}, { goal: false }, { goal: { ...goal, threadId: 'other-account-thread' } }]) {
    const f = fixture({ request: () => result });
    await assert.rejects(f.sync.refresh(active), /codex_goal_(snapshot_invalid|thread_mismatch)/);
    assert.deepEqual(f.messages, []);
  }
});

test('an unavailable metadata read preserves the previous state', async () => {
  const f = fixture({ request: () => { throw new Error('unsupported or disconnected'); } });
  await f.sync.refresh(active);
  assert.deepEqual(f.messages, []);
});

test('failed persistence remains retryable on the next goal snapshot', async () => {
  let failed = false;
  const f = fixture({ publish: () => {
    if (!failed) { failed = true; throw new Error('storage unavailable'); }
  } });
  await assert.rejects(f.sync.refresh(active), /storage unavailable/);
  await f.sync.refresh(active);
  assert.equal(f.messages.length, 1);
});

test('AIH-owned and ordinary goal-free sessions never probe native goals', async () => {
  for (const policy of [{ lineage: undefined }, { contextState: { goalSource: 'aih', goal } }]) {
    const f = fixture({ policy });
    await f.sync.refresh(active);
    assert.deepEqual(f.calls, []);
  }
});
