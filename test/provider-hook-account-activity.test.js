'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyProviderHookAccountActivity,
  resolveSessionTurnAction
} = require('../lib/server/provider-hook-account-activity');

function createRecorder() {
  const calls = [];
  return {
    calls,
    markSessionTurn: (provider, accountRef) => calls.push(['mark', provider, accountRef]),
    endSessionTurn: (provider, accountRef) => calls.push(['end', provider, accountRef])
  };
}

test('turn start and turn updates keep the account alive', () => {
  assert.equal(resolveSessionTurnAction('session:turn-started', 'UserPromptSubmit'), 'alive');
  assert.equal(resolveSessionTurnAction('session:turn-updated', 'PreToolUse'), 'alive');
});

test('a subagent finishing does not end the main turn', () => {
  // SubagentStop 归一后同样是 turn-completed，但主回合还在跑。
  assert.equal(resolveSessionTurnAction('session:turn-completed', 'SubagentStop'), 'alive');
  assert.equal(resolveSessionTurnAction('session:turn-completed', 'TaskCompleted'), 'alive');
  assert.equal(resolveSessionTurnAction('session:turn-completed', 'Stop'), 'done');
});

test('turn failure and session close both end the turn', () => {
  assert.equal(resolveSessionTurnAction('session:turn-failed', 'StopFailure'), 'done');
  assert.equal(resolveSessionTurnAction('session:closed', 'SessionEnd'), 'done');
});

test('session close ends the turn even under a subordinate event name', () => {
  assert.equal(resolveSessionTurnAction('session:closed', 'SubagentStop'), 'done');
});

test('events unrelated to a running turn leave activity untouched', () => {
  assert.equal(resolveSessionTurnAction('session:opened', 'SessionStart'), null);
  assert.equal(resolveSessionTurnAction('session:updated', 'ConfigChange'), null);
  assert.equal(resolveSessionTurnAction('session:file-changed', 'FileChanged'), null);
});

// accountRef 的合法形状是 acct_<20 位 hex>（provider-session-context 归一规则）。
test('a claude cli turn marks the account it was launched with', () => {
  const activity = createRecorder();
  const applied = applyProviderHookAccountActivity({
    accountActivity: activity,
    provider: 'Claude',
    accountRef: 'acct_0123456789abcdef0123',
    eventType: 'session:turn-started',
    eventName: 'UserPromptSubmit'
  });

  assert.equal(applied, true);
  assert.deepEqual(activity.calls, [['mark', 'claude', 'acct_0123456789abcdef0123']]);
});

test('a hook without an account ref is skipped instead of guessed', () => {
  const activity = createRecorder();
  const applied = applyProviderHookAccountActivity({
    accountActivity: activity,
    provider: 'claude',
    accountRef: '',
    eventType: 'session:turn-started',
    eventName: 'UserPromptSubmit'
  });

  assert.equal(applied, false);
  assert.deepEqual(activity.calls, []);
});

test('stop hooks end the turn on the same account key', () => {
  const activity = createRecorder();
  applyProviderHookAccountActivity({
    accountActivity: activity,
    provider: 'claude',
    accountRef: 'acct_0123456789abcdef0123',
    eventType: 'session:turn-completed',
    eventName: 'Stop'
  });

  assert.deepEqual(activity.calls, [['end', 'claude', 'acct_0123456789abcdef0123']]);
});

test('an activity tracker without the session channel degrades quietly', () => {
  const applied = applyProviderHookAccountActivity({
    accountActivity: { begin() {}, end() {} },
    provider: 'claude',
    accountRef: 'acct_0123456789abcdef0123',
    eventType: 'session:turn-started',
    eventName: 'UserPromptSubmit'
  });
  assert.equal(applied, false);
});
