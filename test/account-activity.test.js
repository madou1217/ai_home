'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountActivity, DEFAULT_RATE_WINDOW_MS } = require('../lib/server/account-activity');

function createClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; }
  };
}

test('begin/end pairs track in-flight per account', () => {
  const { now } = createClock();
  const activity = createAccountActivity({ now });
  activity.begin('codex', 'acct_1');
  activity.begin('codex', 'acct_1');

  let snap = activity.snapshot();
  assert.equal(snap['codex:acct_1'].inFlight, 2);
  assert.equal(snap['codex:acct_1'].rate, 2);

  activity.end('codex', 'acct_1');
  snap = activity.snapshot();
  assert.equal(snap['codex:acct_1'].inFlight, 1);

  activity.end('codex', 'acct_1');
  snap = activity.snapshot();
  assert.equal(snap['codex:acct_1'].inFlight, 0);
});

test('activeModels only reports models with live concurrent attempts', () => {
  const { now } = createClock();
  const activity = createAccountActivity({ now });

  activity.begin('agy', 'acct_1', 'gemini-3.7-flash-high');
  activity.begin('agy', 'acct_1', 'claude-opus-4-6-thinking');
  activity.begin('agy', 'acct_1', 'claude-opus-4-6-thinking');

  assert.deepEqual(activity.snapshot()['agy:acct_1'].activeModels, [
    'claude-opus-4-6-thinking',
    'gemini-3.7-flash-high'
  ]);

  activity.end('agy', 'acct_1', 'claude-opus-4-6-thinking');
  assert.deepEqual(activity.snapshot()['agy:acct_1'].activeModels, [
    'claude-opus-4-6-thinking',
    'gemini-3.7-flash-high'
  ]);

  activity.end('agy', 'acct_1', 'gemini-3.7-flash-high');
  assert.deepEqual(activity.snapshot()['agy:acct_1'].activeModels, [
    'claude-opus-4-6-thinking'
  ]);

  activity.end('agy', 'acct_1', 'claude-opus-4-6-thinking');
  assert.deepEqual(activity.snapshot()['agy:acct_1'].activeModels, []);
});

test('legacy begin/end calls without a model keep account activity compatible', () => {
  const { now } = createClock();
  const activity = createAccountActivity({ now });

  activity.begin('codex', 'acct_1');
  assert.deepEqual(activity.snapshot()['codex:acct_1'].activeModels, []);

  activity.end('codex', 'acct_1');
  assert.equal(activity.snapshot()['codex:acct_1'].inFlight, 0);
  assert.deepEqual(activity.snapshot()['codex:acct_1'].activeModels, []);
});

test('end never drives in-flight below zero', () => {
  const { now } = createClock();
  const activity = createAccountActivity({ now });
  activity.begin('codex', 'acct_1');
  activity.end('codex', 'acct_1');
  activity.end('codex', 'acct_1');
  assert.equal(activity.snapshot()['codex:acct_1'].inFlight, 0);
});

test('end on an unknown account is a no-op and creates no state', () => {
  const { now } = createClock();
  const activity = createAccountActivity({ now });
  activity.end('codex', 'acct_never_started');
  assert.deepEqual(activity.snapshot(), {});
});

test('rate counts requests within the window and prunes older ones', () => {
  const clock = createClock();
  const activity = createAccountActivity({ now: clock.now, windowMs: 10_000 });
  activity.begin('codex', 'acct_1');
  clock.advance(4_000);
  activity.begin('codex', 'acct_1');
  clock.advance(4_000);
  activity.begin('codex', 'acct_1');
  assert.equal(activity.snapshot()['codex:acct_1'].rate, 3);

  clock.advance(5_000);
  // 最旧采样已超 10s 窗口（9s+5s=14s 距第一个采样），只留下 2 个
  assert.equal(activity.snapshot()['codex:acct_1'].rate, 2);
});

test('snapshot emits provider, accountRef and timestamps', () => {
  const { now } = createClock();
  const activity = createAccountActivity({ now });
  activity.begin('codex', 'acct_1');
  const snap = activity.snapshot();
  assert.deepEqual(snap['codex:acct_1'], {
    provider: 'codex',
    accountRef: 'acct_1',
    inFlight: 1,
    sessionTurnActive: false,
    rate: 1,
    activeModels: [],
    lastActivityAt: 1_000_000,
    updatedAt: 1_000_000
  });
});

test('provider keys are normalized to lowercase', () => {
  const { now } = createClock();
  const activity = createAccountActivity({ now });
  activity.begin('Codex', 'acct_1');
  assert.ok(activity.snapshot()['codex:acct_1']);
  assert.ok(!activity.snapshot()['Codex:acct_1']);
});

test('empty accountRef is ignored', () => {
  const { now } = createClock();
  const activity = createAccountActivity({ now });
  activity.begin('codex', '');
  activity.begin('codex', '   ');
  assert.deepEqual(activity.snapshot(), {});
});

test('idle accounts are pruned from snapshot state', () => {
  const { now } = createClock();
  const activity = createAccountActivity({ now });
  activity.begin('codex', 'acct_1');
  activity.end('codex', 'acct_1');
  // 无采样残留且 lastActivityAt=0 才删除；这里 begin 已写 lastActivityAt，因此保留
  const snap = activity.snapshot();
  assert.equal(snap['codex:acct_1'].inFlight, 0);
});

test('DEFAULT_RATE_WINDOW_MS is exported', () => {
  assert.equal(DEFAULT_RATE_WINDOW_MS, 10_000);
});

test('a native session turn lights the account up without a gateway attempt', () => {
  const clock = createClock();
  const activity = createAccountActivity({ now: clock.now });

  activity.markSessionTurn('claude', 'claude_9');
  const snap = activity.snapshot();
  assert.equal(snap['claude:claude_9'].inFlight, 1);
  assert.equal(snap['claude:claude_9'].sessionTurnActive, true);
  // 会话回合不是网关请求，不该污染速率语义。
  assert.equal(snap['claude:claude_9'].rate, 0);
});

test('session turn ends immediately instead of waiting for the ttl', () => {
  const clock = createClock();
  const activity = createAccountActivity({ now: clock.now });

  activity.markSessionTurn('claude', 'claude_9');
  activity.endSessionTurn('claude', 'claude_9');

  const snap = activity.snapshot();
  assert.equal(snap['claude:claude_9'].inFlight, 0);
  assert.equal(snap['claude:claude_9'].sessionTurnActive, false);
});

test('a lost stop hook expires instead of spinning forever', () => {
  const clock = createClock();
  const activity = createAccountActivity({ now: clock.now, sessionTurnTtlMs: 30_000 });

  activity.markSessionTurn('claude', 'claude_9');
  clock.advance(29_000);
  assert.equal(activity.snapshot()['claude:claude_9'].inFlight, 1);

  clock.advance(2_000);
  assert.equal(activity.snapshot()['claude:claude_9'].inFlight, 0);
});

test('turn events keep refreshing the ttl while the turn is still running', () => {
  const clock = createClock();
  const activity = createAccountActivity({ now: clock.now, sessionTurnTtlMs: 30_000 });

  activity.markSessionTurn('claude', 'claude_9');
  clock.advance(25_000);
  activity.markSessionTurn('claude', 'claude_9');
  clock.advance(25_000);

  assert.equal(activity.snapshot()['claude:claude_9'].inFlight, 1);
});

test('gateway attempts and session turns stack on the same account', () => {
  const clock = createClock();
  const activity = createAccountActivity({ now: clock.now });

  activity.begin('claude', 'claude_9', 'claude-opus-5');
  activity.markSessionTurn('claude', 'claude_9');
  assert.equal(activity.snapshot()['claude:claude_9'].inFlight, 2);

  activity.end('claude', 'claude_9', 'claude-opus-5');
  assert.equal(activity.snapshot()['claude:claude_9'].inFlight, 1);
});
