const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveRequestProvider,
  chooseServerAccount,
  pickWeightedRandomAccount,
  markProxyAccountSuccess,
  markProxyAccountFailure
} = require('../lib/server/router');
const { summarizeAccountAvailability } = require('../lib/server/account-availability');

test('resolveRequestProvider respects explicit mode and model hint', () => {
  assert.equal(resolveRequestProvider({ provider: 'codex' }, { model: 'gemini-2.5-flash' }), 'codex');
  assert.equal(resolveRequestProvider({ provider: 'gemini' }, { model: 'gpt-4o-mini' }), 'gemini');
  assert.equal(resolveRequestProvider({ provider: 'claude' }, { model: 'gpt-4o-mini' }), 'claude');
  assert.equal(resolveRequestProvider({ provider: 'auto' }, { model: 'gemini-2.5-pro' }), 'gemini');
  assert.equal(resolveRequestProvider({ provider: 'auto' }, { model: 'claude-sonnet-4-5' }), 'claude');
  assert.equal(resolveRequestProvider({ provider: 'auto' }, { model: 'gpt-dynamic' }), 'codex');
  assert.equal(resolveRequestProvider({ provider: 'auto' }, {}), 'codex');
  assert.equal(
    resolveRequestProvider(
      { provider: 'auto' },
      { model: 'qwen3.6-plus' },
      { 'x-provider': 'claude' }
    ),
    'claude'
  );
});

test('chooseServerAccount does round-robin and skips cooldown', () => {
  const now = Date.now();
  const accounts = [
    { id: '1', cooldownUntil: now + 60_000 },
    { id: '2', cooldownUntil: 0 },
    { id: '3', cooldownUntil: 0 }
  ];
  const state = { strategy: 'round-robin', cursor: 0 };

  const a1 = chooseServerAccount(accounts, state, 'cursor');
  const a2 = chooseServerAccount(accounts, state, 'cursor');
  const a3 = chooseServerAccount(accounts, state, 'cursor');

  assert.equal(a1.id, '2');
  assert.equal(a2.id, '3');
  assert.equal(a3.id, '2');
});

test('pickWeightedRandomAccount favors higher remainingPct weights', () => {
  const accounts = [
    { id: '1', remainingPct: 1 },
    { id: '2', remainingPct: 100 }
  ];
  const originalRandom = Math.random;
  Math.random = () => 0.9999;
  try {
    const picked = pickWeightedRandomAccount(accounts);
    assert.equal(picked.id, '2');
  } finally {
    Math.random = originalRandom;
  }
});

test('chooseServerAccount keeps sticky session when session key is provided', () => {
  const now = Date.now();
  const accounts = [
    { id: '1', cooldownUntil: now + 60_000, remainingPct: 10 },
    { id: '2', cooldownUntil: 0, remainingPct: 90 },
    { id: '3', cooldownUntil: 0, remainingPct: 30 }
  ];
  const state = { strategy: 'random' };
  const originalRandom = Math.random;
  try {
    Math.random = () => 0.1;
    const first = chooseServerAccount(accounts, state, 'codex', { provider: 'codex', sessionKey: 'sess-1' });
    assert.equal(first.id, '2');

    Math.random = () => 0.99;
    const second = chooseServerAccount(accounts, state, 'codex', { provider: 'codex', sessionKey: 'sess-1' });
    assert.equal(second.id, '2');
  } finally {
    Math.random = originalRandom;
  }
});

test('chooseServerAccount honors excludeIds to avoid duplicate picks in one request', () => {
  const now = Date.now();
  const accounts = [
    { id: '1', cooldownUntil: 0, remainingPct: 90 },
    { id: '2', cooldownUntil: 0, remainingPct: 10 },
    { id: '3', cooldownUntil: now + 60_000, remainingPct: 100 }
  ];
  const state = { strategy: 'random' };
  const originalRandom = Math.random;
  try {
    Math.random = () => 0.01;
    const first = chooseServerAccount(accounts, state, 'codex', { provider: 'codex' });
    assert.equal(first.id, '1');

    const second = chooseServerAccount(accounts, state, 'codex', {
      provider: 'codex',
      excludeIds: new Set(['1'])
    });
    assert.equal(second.id, '2');
  } finally {
    Math.random = originalRandom;
  }
});

test('chooseServerAccount skips policy-blocked accounts and exhausted remainingPct=0 accounts', () => {
  const accounts = [
    { id: '1', cooldownUntil: 0, schedulableStatus: 'blocked_by_policy', schedulableReason: 'codex_team_plan_missing_rate_limits', remainingPct: 80 },
    { id: '2', cooldownUntil: 0, remainingPct: 0 },
    { id: '3', cooldownUntil: 0, remainingPct: 45 }
  ];
  const state = { strategy: 'round-robin', cursor: 0 };

  const picked = chooseServerAccount(accounts, state, 'cursor');
  assert.equal(picked.id, '3');
});

test('summarizeAccountAvailability explains why no account can be selected', () => {
  const now = Date.now();
  const summary = summarizeAccountAvailability([
    {
      id: '1',
      schedulableStatus: 'blocked_by_runtime_status',
      schedulableReason: 'auth_invalid',
      cooldownUntil: now + 60_000
    },
    {
      id: '2',
      schedulableStatus: 'blocked_by_policy',
      schedulableReason: 'codex_free_plan_below_server_min_remaining',
      cooldownUntil: 0
    },
    {
      id: '3',
      schedulableStatus: 'schedulable',
      cooldownUntil: now + 30_000,
      lastError: 'upstream_502'
    }
  ], {
    provider: 'codex',
    now
  });

  assert.equal(summary.total, 3);
  assert.equal(summary.available, 0);
  assert.match(summary.detail, /blocked_by_runtime_status:auth_invalid=1/);
  assert.match(summary.detail, /blocked_by_policy:codex_free_plan_below_server_min_remaining=1/);
  assert.match(summary.detail, /cooldown:upstream_502=1/);
});

test('mark success/failure updates account runtime fields', () => {
  const acc = { consecutiveFailures: 1, successCount: 0, failCount: 0, lastError: 'x', cooldownUntil: 0 };
  markProxyAccountSuccess(acc);
  assert.equal(acc.consecutiveFailures, 0);
  assert.equal(acc.successCount, 1);
  assert.equal(acc.lastError, '');

  markProxyAccountFailure(acc, 'boom', 5000, 2);
  assert.equal(acc.failCount, 1);
  assert.equal(acc.consecutiveFailures, 1);
  assert.equal(acc.lastError, 'boom');
  assert.equal(acc.cooldownUntil, 0);

  markProxyAccountFailure(acc, 'boom2', 5000, 2);
  assert.equal(acc.consecutiveFailures, 2);
  assert.ok(acc.cooldownUntil > Date.now());
});
