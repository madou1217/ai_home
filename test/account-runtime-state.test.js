const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeAccountRuntime,
  replacePersistedAccountRuntimeState,
  touchAccountFailureState,
  touchAccountSuccessState,
  clearExpiredAccountRuntimeState,
  deriveAccountRuntimeStatus,
  applyAccountFailurePolicy
} = require('../lib/server/account-runtime-state');
// Use the real failure/success bookkeeping so these tests validate the actual
// production composition the transient-cooldown gate depends on.
const {
  markProxyAccountFailure,
  markProxyAccountSuccess
} = require('../lib/server/router');

const NETWORK_POLICY = Object.freeze({
  kind: 'network_error',
  shouldMarkFailure: true,
  shouldRetryAnotherAccount: true,
  failureThreshold: 2,
  cooldownMs: 30000,
  scope: 'account',
  failureReason: 'fetch failed [UND_ERR_SOCKET]'
});

function healthyAccount() {
  return normalizeAccountRuntime({ id: 'x', accessToken: 'tok', remainingPct: 100 });
}

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

test('applyAccountFailurePolicy keeps an account routable after a single transient network blip', () => {
  const account = healthyAccount();
  applyAccountFailurePolicy(account, NETWORK_POLICY, { markProxyAccountFailure });

  assert.equal(account.consecutiveFailures, 1);
  assert.equal(account.networkUntil, 0);
  assert.equal(account.cooldownUntil, 0);
  assert.equal(deriveAccountRuntimeStatus(account).status, 'healthy');
});

test('applyAccountFailurePolicy only cools the account after consecutive transient failures', () => {
  const account = healthyAccount();
  applyAccountFailurePolicy(account, NETWORK_POLICY, { markProxyAccountFailure });
  applyAccountFailurePolicy(account, NETWORK_POLICY, { markProxyAccountFailure });

  assert.equal(account.consecutiveFailures, 2);
  assert.equal(account.networkUntil > Date.now(), true);
  assert.equal(deriveAccountRuntimeStatus(account).status, 'transient_network');
});

test('applyAccountFailurePolicy resets the transient streak after an intervening success', () => {
  const account = healthyAccount();
  applyAccountFailurePolicy(account, NETWORK_POLICY, { markProxyAccountFailure });
  markProxyAccountSuccess(account);
  applyAccountFailurePolicy(account, NETWORK_POLICY, { markProxyAccountFailure });

  assert.equal(account.consecutiveFailures, 1);
  assert.equal(deriveAccountRuntimeStatus(account).status, 'healthy');
});

test('applyAccountFailurePolicy still cools immediately for threshold-1 account failures', () => {
  const account = healthyAccount();
  applyAccountFailurePolicy(account, {
    kind: 'overloaded',
    shouldMarkFailure: true,
    failureThreshold: 1,
    cooldownMs: 600000,
    scope: 'account',
    failureReason: 'account overloaded'
  }, { markProxyAccountFailure });

  assert.equal(account.overloadUntil > Date.now(), true);
  assert.equal(deriveAccountRuntimeStatus(account).status, 'overloaded');
});

test('applyAccountFailurePolicy keeps model-scoped failures off the account-wide buckets', () => {
  const account = healthyAccount();
  applyAccountFailurePolicy(account, {
    kind: 'rate_limited',
    shouldMarkFailure: true,
    failureThreshold: 1,
    cooldownMs: 300000,
    scope: 'model',
    failureReason: 'rate limited'
  }, { markProxyAccountFailure, model: 'claude-opus-4-6-thinking' });

  assert.equal(account.cooldownUntil, 0);
  assert.equal(account.networkUntil, 0);
  assert.equal(deriveAccountRuntimeStatus(account).status, 'healthy');
  assert.equal(account.modelCooldowns['claude-opus-4-6-thinking'] > Date.now(), true);
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
