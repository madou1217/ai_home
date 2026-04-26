const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeAccountRuntime,
  touchAccountFailureState,
  clearExpiredAccountRuntimeState,
  deriveAccountRuntimeStatus
} = require('../lib/server/account-runtime-state');

test('touchAccountFailureState records classified cooldown buckets', () => {
  const now = 1000;
  const account = normalizeAccountRuntime({ id: '1' });
  touchAccountFailureState(account, {
    kind: 'rate_limited',
    cooldownMs: 60000,
    failureReason: 'quota exhausted'
  }, now);

  assert.equal(account.rateLimitUntil, 61000);
  assert.equal(account.cooldownUntil, 61000);
  assert.equal(account.lastFailureKind, 'rate_limited');
  assert.equal(account.lastFailureReason, 'quota exhausted');
});

test('deriveAccountRuntimeStatus prefers specific runtime bucket over generic cooldown', () => {
  const status = deriveAccountRuntimeStatus({
    authInvalidUntil: Date.now() + 10000,
    cooldownUntil: Date.now() + 1000,
    lastFailureKind: 'rate_limited',
    lastFailureReason: 'bad token'
  });

  assert.equal(status.status, 'auth_invalid');
  assert.match(status.reason, /bad token/);
});

test('clearExpiredAccountRuntimeState clears cooldown and stale failure kind after recovery', () => {
  const account = normalizeAccountRuntime({
    cooldownUntil: 100,
    rateLimitUntil: 100,
    lastFailureKind: 'rate_limited',
    lastFailureReason: 'quota exhausted',
    consecutiveFailures: 3
  });

  clearExpiredAccountRuntimeState(account, 200);

  assert.equal(account.cooldownUntil, 0);
  assert.equal(account.rateLimitUntil, 0);
  assert.equal(account.consecutiveFailures, 0);
  assert.equal(account.lastFailureKind, '');
});
