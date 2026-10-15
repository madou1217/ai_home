const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAccountRuntimeGate,
  isProbeRefutableRuntimeState,
  readFailureStatusCode
} = require('../lib/server/account-runtime-gate');
const { ACCOUNT_RUNTIME_CHANGED } = require('../lib/server/account-runtime-event-types');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';

function createHub(events = []) {
  return {
    emit(type, event) {
      if (type === ACCOUNT_RUNTIME_CHANGED) events.push(event);
      return true;
    }
  };
}

function makeAccount(overrides = {}) {
  return {
    accountRef: ACCOUNT_REF,
    provider: 'codex',
    apiKeyMode: true,
    displayName: 'relay.example.com',
    ...overrides
  };
}

test('observeFailure classifies with the same rules as an inference request and publishes one event', () => {
  const events = [];
  const gate = createAccountRuntimeGate({ hub: createHub(events) });
  const account = makeAccount();
  const { policy, applied, status } = gate.observeFailure({
    account,
    provider: 'codex',
    source: 'server.probe.models',
    statusCode: 401,
    body: '{"error":{"code":"invalid_api_key"}}'
  });
  assert.equal(policy.kind, 'auth_invalid');
  assert.equal(applied, true);
  assert.equal(status, 'auth_invalid');
  assert.equal(account.lastFailureKind, 'auth_invalid');
  assert.equal(account.authInvalidUntil > Date.now(), true);
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'server.probe.models');
  assert.equal(events[0].nextStatus, 'auth_invalid');
  assert.equal(events[0].runtimeState.lastFailureKind, 'auth_invalid');
});

test('observeFailure reads the status from HTTP_<code> error codes and does nothing for success policies', () => {
  const events = [];
  const gate = createAccountRuntimeGate({ hub: createHub(events) });
  const account = makeAccount();
  assert.equal(readFailureStatusCode(Object.assign(new Error('HTTP 403'), { code: 'HTTP_403' }), ''), 403);
  assert.equal(readFailureStatusCode(Object.assign(new Error('nope'), { status: 429 }), ''), 429);
  // 从异常对象还原状态码：HTTP_401 → auth_invalid（与推理路径同一分类结果）。
  const fromError = gate.observeFailure({
    account,
    provider: 'codex',
    error: Object.assign(new Error('HTTP 401 unauthorized'), { code: 'HTTP_401' })
  });
  assert.equal(fromError.policy.kind, 'auth_invalid');
  assert.equal(events.length, 1);
  // 分类器明确「不记账」的策略（如请求作用域的安全拒绝）不得写运行态。
  const skipped = gate.observeFailure({
    account,
    provider: 'codex',
    policy: { kind: 'safety_rejected', shouldMarkFailure: false }
  });
  assert.equal(skipped.applied, false);
  assert.equal(events.length, 1);
});

test('probe success clears auth/transient blocks but never rate-limit or quota blocks', () => {
  const events = [];
  const gate = createAccountRuntimeGate({ hub: createHub(events) });
  const authBlocked = makeAccount({
    authInvalidUntil: Date.now() + 365 * 86400000,
    cooldownUntil: Date.now() + 365 * 86400000,
    lastFailureKind: 'auth_invalid'
  });
  assert.equal(gate.observeProbeSuccess({ account: authBlocked, provider: 'codex' }).cleared, true);
  assert.equal(authBlocked.authInvalidUntil, 0);
  assert.equal(authBlocked.cooldownUntil, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'models_probe_success');

  const rateLimited = makeAccount({
    rateLimitUntil: Date.now() + 300000,
    cooldownUntil: Date.now() + 300000,
    lastFailureKind: 'rate_limited'
  });
  assert.equal(gate.observeProbeSuccess({ account: rateLimited, provider: 'codex' }).reason, 'not_refutable');
  assert.equal(rateLimited.rateLimitUntil > Date.now(), true);

  const billingBlocked = makeAccount({
    lastFailureKind: 'billing_blocked',
    routingBlock: { kind: 'billing_blocked', reason: 'billing_blocked', observedAt: Date.now() }
  });
  assert.equal(gate.observeProbeSuccess({ account: billingBlocked, provider: 'codex' }).reason, 'not_refutable');
  assert.equal(billingBlocked.routingBlock.kind, 'billing_blocked');
});

test('probe success keeps concurrent rate limits when clearing an auth block', () => {
  const gate = createAccountRuntimeGate({});
  const account = makeAccount({
    authInvalidUntil: Date.now() + 365 * 86400000,
    rateLimitUntil: Date.now() + 300000,
    cooldownUntil: Date.now() + 365 * 86400000,
    lastFailureKind: 'auth_invalid'
  });
  assert.equal(gate.observeProbeSuccess({ account, provider: 'codex' }).cleared, true);
  assert.equal(account.authInvalidUntil, 0);
  assert.equal(account.rateLimitUntil > Date.now(), true, '并发限流不能被探测成功清掉');
  assert.equal(account.cooldownUntil, account.rateLimitUntil);
});

test('agy non-recoverable auth block only yields to its own usage probe evidence', () => {
  const gate = createAccountRuntimeGate({});
  const agyBlocked = makeAccount({
    provider: 'agy',
    apiKeyMode: false,
    authInvalidUntil: Date.now() + 365 * 86400000,
    lastFailureKind: 'auth_invalid',
    lastFailureReason: 'agy_not_signed_in',
    lastError: 'agy_not_signed_in'
  });
  assert.equal(
    gate.observeProbeSuccess({ account: agyBlocked, provider: 'agy' }).reason,
    'non_recoverable'
  );
  assert.equal(agyBlocked.authInvalidUntil > Date.now(), true);
  assert.equal(
    gate.observeProbeSuccess({ account: agyBlocked, provider: 'agy', evidence: 'agy_usage_probe_verified' }).cleared,
    true
  );
  assert.equal(agyBlocked.authInvalidUntil, 0);
});

test('forceRecover zeroes account-wide state, routing block and model cooldowns', () => {
  const events = [];
  const gate = createAccountRuntimeGate({ hub: createHub(events) });
  const account = makeAccount({
    authInvalidUntil: Date.now() + 86400000,
    rateLimitUntil: Date.now() + 300000,
    cooldownUntil: Date.now() + 86400000,
    lastFailureKind: 'billing_blocked',
    lastError: 'billing_blocked',
    routingBlock: { kind: 'billing_blocked', reason: 'billing_blocked', observedAt: Date.now() },
    modelCooldowns: { 'gpt-5.4': Date.now() + 300000 },
    modelFailureStreaks: { 'gpt-5.4': { kind: 'rate_limited', count: 3, expiresAt: Date.now() + 300000 } },
    consecutiveFailures: 4
  });
  assert.equal(gate.forceRecover({ account, provider: 'codex' }).recovered, true);
  assert.equal(account.authInvalidUntil, 0);
  assert.equal(account.rateLimitUntil, 0);
  assert.equal(account.cooldownUntil, 0);
  assert.equal(account.routingBlock, null);
  assert.deepEqual(account.modelCooldowns, {});
  assert.deepEqual(account.modelFailureStreaks, {});
  assert.equal(account.consecutiveFailures, 0);
  assert.equal(account.lastSuccessAt > 0, true);
  assert.equal(events.length, 1);
  // 人工覆盖走 manual_admin_clear 证据，并要求重载运行池。
  assert.equal(events[0].reason, 'manual_admin_clear');
  assert.equal(events[0].reloadPool, true);
});

test('without a hub the gate persists through accountStateService', () => {
  const calls = [];
  const gate = createAccountRuntimeGate({
    accountStateService: {
      recordRuntimeFailure: (accountRef, provider, runtimeState) => {
        calls.push({ accountRef, provider, runtimeState });
        return true;
      }
    }
  });
  const account = makeAccount();
  gate.observeFailure({ account, provider: 'codex', statusCode: 401, body: 'unauthorized' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'codex');
  assert.equal(calls[0].runtimeState.lastFailureKind, 'auth_invalid');
});

test('isProbeRefutableRuntimeState only accepts credential/transient evidence', () => {
  assert.equal(isProbeRefutableRuntimeState({ lastFailureKind: 'auth_invalid' }, Date.now()), true);
  assert.equal(isProbeRefutableRuntimeState({ lastFailureKind: 'unknown_error' }, Date.now()), true);
  assert.equal(isProbeRefutableRuntimeState({ lastFailureKind: 'rate_limited' }, Date.now()), false);
  assert.equal(isProbeRefutableRuntimeState({ lastFailureKind: 'quota_exhausted' }, Date.now()), false);
  assert.equal(isProbeRefutableRuntimeState({ lastFailureKind: '' }, Date.now()), false);
});

