const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeAccountRuntime,
  replacePersistedAccountRuntimeState,
  touchAccountFailureState,
  touchAccountSuccessState,
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

test('touchAccountSuccessState clears stale blocking runtime buckets after recovery', () => {
  const account = normalizeAccountRuntime({
    successCount: 4,
    failCount: 3,
    consecutiveFailures: 2,
    lastError: 'auth_invalid_reauth_required',
    lastFailureKind: 'auth_invalid',
    lastFailureReason: 'auth_invalid_reauth_required',
    lastFailureAt: 100,
    cooldownUntil: 60_000,
    authInvalidUntil: 60_000,
    rateLimitUntil: 60_000
  });

  touchAccountSuccessState(account, 200);

  assert.equal(account.successCount, 4);
  assert.equal(account.failCount, 3);
  assert.equal(account.consecutiveFailures, 0);
  assert.equal(account.lastError, '');
  assert.equal(account.lastFailureKind, '');
  assert.equal(account.lastFailureReason, '');
  assert.equal(account.lastFailureAt, 0);
  assert.equal(account.cooldownUntil, 0);
  assert.equal(account.authInvalidUntil, 0);
  assert.equal(account.rateLimitUntil, 0);
  assert.equal(account.lastSuccessAt, 200);
  assert.equal(deriveAccountRuntimeStatus(account, 200).status, 'healthy');
});

test('replacePersistedAccountRuntimeState clears stale blocking fields when persisted runtime is empty', () => {
  const account = normalizeAccountRuntime({
    successCount: 7,
    failCount: 2,
    cooldownUntil: Date.now() + 60_000,
    rateLimitUntil: Date.now() + 60_000,
    lastFailureKind: 'rate_limited',
    lastFailureReason: 'usage_limit_reached'
  });

  replacePersistedAccountRuntimeState(account, null);

  assert.equal(account.successCount, 7);
  assert.equal(account.failCount, 2);
  assert.equal(account.cooldownUntil, 0);
  assert.equal(account.rateLimitUntil, 0);
  assert.equal(account.lastFailureKind, '');
  assert.equal(deriveAccountRuntimeStatus(account).status, 'healthy');
});
