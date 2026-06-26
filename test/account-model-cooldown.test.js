'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeAccountRuntime,
  getAccountModelCooldownUntil,
  clearAccountModelState,
  clearExpiredAccountModelState,
  pickPersistedAccountRuntimeState,
  applyPersistedAccountRuntimeState
} = require('../lib/server/account-runtime-state');
const { markProxyAccountFailure, markProxyAccountSuccess, chooseServerAccount } = require('../lib/server/router');
const { applyAccountFailurePolicy } = require('../lib/server/account-runtime-state');
const { classifyUpstreamFailure } = require('../lib/server/upstream-failure-policy');

test('model-scoped failure cools only that (account, model) tuple', () => {
  const account = normalizeAccountRuntime({ id: '1', provider: 'agy' });
  markProxyAccountFailure(account, '429 quota', 5 * 60_000, 1, { scope: 'model', model: 'claude-opus-4-6-thinking' });

  // claude model is cooling down...
  assert.ok(getAccountModelCooldownUntil(account, 'claude-opus-4-6-thinking') > Date.now());
  // ...but the account itself is NOT account-wide cooled, and gemini is free.
  assert.equal(account.cooldownUntil, 0);
  assert.equal(account.consecutiveFailures, 0);
  assert.equal(getAccountModelCooldownUntil(account, 'gemini-3.5-flash-low'), 0);
});

test('account-scoped failure still cools the whole account (auth etc.)', () => {
  const account = normalizeAccountRuntime({ id: '1', provider: 'claude' });
  markProxyAccountFailure(account, 'auth_invalid', 60_000, 1);
  assert.ok(account.cooldownUntil > Date.now());
});

test('success on a model clears that model cooldown', () => {
  const account = normalizeAccountRuntime({ id: '1', provider: 'agy' });
  markProxyAccountFailure(account, '429', 60_000, 1, { scope: 'model', model: 'claude-opus-4-6-thinking' });
  assert.ok(getAccountModelCooldownUntil(account, 'claude-opus-4-6-thinking') > Date.now());
  markProxyAccountSuccess(account, { model: 'claude-opus-4-6-thinking' });
  assert.equal(getAccountModelCooldownUntil(account, 'claude-opus-4-6-thinking'), 0);
});

test('chooseServerAccount skips an account only for the cooled model', () => {
  const cooled = normalizeAccountRuntime({ id: '1', provider: 'agy', apiKeyMode: false, schedulableStatus: 'schedulable' });
  markProxyAccountFailure(cooled, '429', 5 * 60_000, 1, { scope: 'model', model: 'claude-opus-4-6-thinking' });
  const pool = [cooled];
  const state = {};

  // For the cooled model: no account available.
  assert.equal(chooseServerAccount(pool, state, 'agy', { provider: 'agy', model: 'claude-opus-4-6-thinking' }), null);
  // For a different model on the same account: still available.
  const picked = chooseServerAccount(pool, state, 'agy', { provider: 'agy', model: 'gemini-3.5-flash-low' });
  assert.equal(picked && picked.id, '1');
});

test('chooseServerAccount allowModelCooled serves a soft-cooled account as last resort', () => {
  const cooled = normalizeAccountRuntime({ id: '1', provider: 'agy', apiKeyMode: false, schedulableStatus: 'schedulable' });
  markProxyAccountFailure(cooled, '429', 5 * 60_000, 1, { scope: 'model', model: 'claude-opus-4-6-thinking' });
  const pool = [cooled];

  // Normal selection still skips the cooled model (load-spreading intact)...
  assert.equal(chooseServerAccount(pool, {}, 'agy', { provider: 'agy', model: 'claude-opus-4-6-thinking' }), null);
  // ...but with allowModelCooled the same account is served rather than 503'ing.
  const picked = chooseServerAccount(pool, {}, 'agy', {
    provider: 'agy',
    model: 'claude-opus-4-6-thinking',
    allowModelCooled: true
  });
  assert.equal(picked && picked.id, '1');
});

test('allowModelCooled does NOT override account-level (hard) cooldown', () => {
  const hardDown = normalizeAccountRuntime({ id: '1', provider: 'agy', apiKeyMode: false, schedulableStatus: 'schedulable' });
  // Account-wide auth cooldown (credential failure) — must stay out of rotation
  // even under last resort.
  markProxyAccountFailure(hardDown, 'auth_invalid', 60 * 60_000, 1);
  const pool = [hardDown];
  assert.equal(chooseServerAccount(pool, {}, 'agy', {
    provider: 'agy',
    model: 'claude-opus-4-6-thinking',
    allowModelCooled: true
  }), null);
});

test('clearExpiredAccountModelState prunes elapsed cooldowns', () => {
  const account = normalizeAccountRuntime({ id: '1' });
  account.modelCooldowns = { 'm-old': Date.now() - 1000, 'm-new': Date.now() + 60_000 };
  account.modelFailures = { 'm-old': 3, 'm-new': 1 };
  clearExpiredAccountModelState(account);
  assert.equal(account.modelCooldowns['m-old'], undefined);
  assert.ok(account.modelCooldowns['m-new'] > Date.now());
  assert.equal(account.modelFailures['m-old'], undefined);
});

test('model cooldowns survive a pool reload (persisted + restored)', () => {
  const account = normalizeAccountRuntime({ id: '1', provider: 'agy' });
  markProxyAccountFailure(account, '429', 5 * 60_000, 1, { scope: 'model', model: 'claude-opus-4-6-thinking' });
  // persist (JSON round-trip mimics the runtime_state TEXT column)
  const persisted = JSON.parse(JSON.stringify(pickPersistedAccountRuntimeState(account)));
  assert.ok(persisted.modelCooldowns && persisted.modelCooldowns['claude-opus-4-6-thinking']);

  // reload: a fresh account object gets the persisted state applied
  const reloaded = normalizeAccountRuntime({ id: '1', provider: 'agy' });
  applyPersistedAccountRuntimeState(reloaded, persisted);
  assert.ok(getAccountModelCooldownUntil(reloaded, 'claude-opus-4-6-thinking') > Date.now());
  assert.equal(getAccountModelCooldownUntil(reloaded, 'gemini-3.5-flash-low'), 0);
});

test('quota exhausted model failures extend legacy short cooldowns on reload', () => {
  const account = normalizeAccountRuntime({
    id: '1',
    provider: 'agy',
    lastFailureKind: 'model_quota_exhausted',
    lastFailureReason: 'HTTP 429 Resource has been exhausted (e.g. check quota).',
    lastFailureAt: Date.now() - 60_000,
    modelCooldowns: {
      'claude-sonnet-4-6': Date.now() - 1_000
    },
    modelFailures: {
      'claude-sonnet-4-6': 2
    }
  });

  assert.ok(getAccountModelCooldownUntil(account, 'claude-sonnet-4-6') > Date.now() + 23 * 60 * 60 * 1000);
  assert.equal(account.cooldownUntil, 0);
});

test('upstream 503 cools only the failing model end-to-end, leaving sibling models routable', () => {
  // Universal principle: a server-side failure (503/529/5xx) on one model must
  // not pull the whole account out of rotation — its other models keep serving.
  const account = normalizeAccountRuntime({
    id: '1',
    provider: 'agy',
    apiKeyMode: false,
    schedulableStatus: 'schedulable'
  });
  const policy = classifyUpstreamFailure({
    provider: 'agy',
    statusCode: 503,
    detail: 'service unavailable',
    defaultCooldownMs: 60_000
  });
  assert.equal(policy.scope, 'model');
  applyAccountFailurePolicy(account, policy, {
    markProxyAccountFailure,
    model: 'claude-opus-4-6-thinking'
  });

  // The account itself stays healthy account-wide...
  assert.equal(account.cooldownUntil, 0);
  // ...the 503'd model is cooled...
  assert.ok(getAccountModelCooldownUntil(account, 'claude-opus-4-6-thinking') > Date.now());
  // ...and a sibling model on the SAME account is still selectable.
  const pool = [account];
  assert.equal(chooseServerAccount(pool, {}, 'agy', { provider: 'agy', model: 'claude-opus-4-6-thinking' }), null);
  const picked = chooseServerAccount(pool, {}, 'agy', { provider: 'agy', model: 'gemini-3.5-flash-low' });
  assert.equal(picked && picked.id, '1');
});

test('threshold > 1 requires repeated model failures before cooling', () => {
  const account = normalizeAccountRuntime({ id: '1' });
  markProxyAccountFailure(account, '429', 60_000, 2, { scope: 'model', model: 'm1' });
  assert.equal(getAccountModelCooldownUntil(account, 'm1'), 0); // 1 < threshold 2
  markProxyAccountFailure(account, '429', 60_000, 2, { scope: 'model', model: 'm1' });
  assert.ok(getAccountModelCooldownUntil(account, 'm1') > Date.now()); // 2 >= threshold
  clearAccountModelState(account, 'm1');
  assert.equal(getAccountModelCooldownUntil(account, 'm1'), 0);
});
