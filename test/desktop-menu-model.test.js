'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDesktopMenuSnapshot,
  __private
} = require('../lib/server/desktop-menu-model');

function account(provider, suffix, overrides = {}) {
  return {
    provider,
    accountRef: `acct_${String(suffix).padStart(20, '0')}`,
    displayName: `${provider}-${suffix}`,
    configured: true,
    apiKeyMode: false,
    authPending: false,
    isDefault: false,
    remainingPct: 75,
    status: 'up',
    ...overrides
  };
}

test('desktop menu contract excludes Gemini and omits providers without accounts', () => {
  const snapshot = buildDesktopMenuSnapshot([
    account('codex', 1),
    account('gemini', 2),
    account('claude', 3)
  ], { now: 123 });

  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.generatedAt, 123);
  assert.deepEqual(snapshot.providers.map((provider) => provider.id), ['codex', 'claude']);
  assert.equal(snapshot.providers.some((provider) => provider.id === 'gemini'), false);
  assert.equal(snapshot.providers.some((provider) => provider.id === 'agy'), false);
});

test('desktop menu contract keeps future non-Gemini providers data-driven', () => {
  const snapshot = buildDesktopMenuSnapshot([
    account('future-provider', 4, { remainingPct: null })
  ]);

  assert.equal(snapshot.providers.length, 1);
  assert.equal(snapshot.providers[0].id, 'future-provider');
  assert.equal(snapshot.providers[0].label, 'Future Provider');
  assert.equal(snapshot.providers[0].accounts[0].usageLabel, '用量未知');
});

test('desktop menu account exposes only safe display state needed by native menus', () => {
  const snapshot = buildDesktopMenuSnapshot([
    account('codex', 5, {
      displayName: 'Main\nAccount',
      isDefault: true,
      remainingPct: 64.44
    }),
    account('codex', 6, {
      configured: false,
      authPending: true,
      remainingPct: null
    })
  ]);

  assert.deepEqual(snapshot.providers[0].accounts, [
    {
      accountRef: 'acct_00000000000000000005',
      label: 'Main Account',
      usageLabel: '剩余 64.4%',
      isDefault: true,
      switchable: true,
      status: 'up'
    },
    {
      accountRef: 'acct_00000000000000000006',
      label: 'codex-6',
      usageLabel: '等待授权',
      isDefault: false,
      switchable: false,
      status: 'up'
    }
  ]);
});

test('desktop menu pending account falls back to a stable account suffix instead of a status label', () => {
  const snapshot = buildDesktopMenuSnapshot([
    account('codex', 13, {
      displayName: '',
      email: '',
      planType: 'pending',
      configured: false,
      authPending: true
    })
  ]);

  assert.equal(snapshot.providers[0].accounts[0].label, '账号 000013');
  assert.equal(snapshot.providers[0].accounts[0].usageLabel, '等待授权');
});

test('desktop menu ignores invalid account identities instead of emitting unsafe item ids', () => {
  const snapshot = buildDesktopMenuSnapshot([
    account('codex', 7, { accountRef: '../../unsafe' }),
    account('bad/provider', 8),
    null
  ]);

  assert.deepEqual(snapshot.providers, []);
});

test('usage label distinguishes zero remaining, API key, disabled, and unknown quota', () => {
  assert.equal(__private.buildUsageLabel(account('codex', 9, { remainingPct: 0 })), '剩余 0%');
  assert.equal(__private.buildUsageLabel(account('codex', 10, { apiKeyMode: true })), 'API Key');
  assert.equal(__private.buildUsageLabel(account('codex', 11, { status: 'down' })), '已停用');
  assert.equal(__private.buildUsageLabel(account('codex', 12, { remainingPct: null })), '用量未知');
});

test('desktop menu does not allow switching to a disabled account', () => {
  const snapshot = buildDesktopMenuSnapshot([
    account('codex', 14, { status: 'down' })
  ]);

  assert.equal(snapshot.providers[0].accounts[0].status, 'down');
  assert.equal(snapshot.providers[0].accounts[0].switchable, false);
});

test('desktop menu does not allow switching to a runtime-blocked account', () => {
  const snapshot = buildDesktopMenuSnapshot([
    account('claude', 15, {
      runtimeStatus: 'auth_invalid',
      schedulableStatus: 'blocked_by_runtime_status'
    })
  ]);

  assert.equal(snapshot.providers[0].accounts[0].usageLabel, '账号异常');
  assert.equal(snapshot.providers[0].accounts[0].switchable, false);
});

test('desktop menu does not allow switching to an otherwise healthy unschedulable account', () => {
  const snapshot = buildDesktopMenuSnapshot([
    account('codex', 16, {
      runtimeStatus: 'healthy',
      schedulableStatus: 'blocked_by_quota'
    })
  ]);

  assert.equal(snapshot.providers[0].accounts[0].usageLabel, '剩余 75%');
  assert.equal(snapshot.providers[0].accounts[0].switchable, false);
});
