'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { recoverQuotaRuntimeState } = require('../lib/account/quota-runtime-recovery');
const { createAccountStateService } = require('../lib/account/state-service');
const { chooseServerAccount } = require('../lib/server/router');
const REF = 'acct_0123456789abcdef0123';
const now = Date.now();
const snapshot = { schemaVersion: 2, kind: 'codex_oauth_status', source: 'codex_app_server', capturedAt: now,
  entries: [{ bucket: 'primary', remainingPct: 100 }, { bucket: 'secondary', remainingPct: 100 }] };
function runtime() {
  return { lastFailureAt: now - 1000, lastFailureKind: 'rate_limited', lastFailureReason: 'usage_limit_reached',
    modelCooldowns: { 'gpt-6.1-sol': now + 5 * 86400000, network: now + 60000 },
    modelFailureStreaks: {
      'gpt-6.1-sol': { kind: 'rate_limited', count: 1, expiresAt: now + 5 * 86400000, reason: 'usage_limit_reached' },
      network: { kind: 'network_error', count: 1, expiresAt: now + 60000, reason: 'ECONNRESET' }
    } };
}

test('a newer verified quota snapshot removes stale quota cooldown and preserves unrelated failures', () => {
  const old = runtime();
  const next = recoverQuotaRuntimeState('codex', old, snapshot);
  assert.deepEqual(next.modelCooldowns, { network: now + 60000 });
  assert.deepEqual(next.modelFailureStreaks, { network: old.modelFailureStreaks.network });
  assert.ok(old.modelCooldowns['gpt-6.1-sol'], 'pure reconciliation never mutates storage input');
  const account = { accountRef: REF, apiKeyMode: false, remainingPct: 100, ...old };
  assert.equal(chooseServerAccount([account], {}, 'codex', { model: 'gpt-6.1-sol', allowModelCooled: true }), null);
  assert.equal(chooseServerAccount([{ ...account, ...next }], {}, 'codex', { model: 'gpt-6.1-sol' }).accountRef, REF);
});

test('old, metadata, depleted, unknown or differently sourced snapshots cannot clear quota', () => {
  for (const invalid of [
    { ...snapshot, capturedAt: now - 2000 }, { ...snapshot, fallbackSource: 'account_read' },
    { ...snapshot, source: 'invented' }, { ...snapshot, entries: [] },
    { ...snapshot, entries: [{ remainingPct: null }] },
    { ...snapshot, entries: [{ remainingPct: 100 }, { remainingPct: 0 }] }
  ]) {
    const old = runtime();
    assert.equal(recoverQuotaRuntimeState('codex', old, invalid), old);
  }
});

test('per-model observation prevents older snapshots from clearing a newer failure', () => {
  const old = runtime();
  old.modelFailureStreaks['gpt-6.1-sol'].observedAt = now + 1;
  const next = recoverQuotaRuntimeState('codex', old, snapshot);
  assert.ok(next.modelCooldowns['gpt-6.1-sol']);
  assert.equal(next.lastFailureReason, 'usage_limit_reached');
});

test('manual routing recovery preserves other cooldowns and malformed usage cannot recover auth', () => {
  let stored = { networkUntil: now + 60000, cooldownUntil: now + 60000,
    lastFailureKind: 'network_error', lastFailureAt: now - 1000,
    routingBlock: { kind: 'billing_blocked', observedAt: now - 2000 } };
  const service = createAccountStateService({ accountStateIndex: {
    getAccountState: () => ({ runtimeState: stored }),
    upsertRuntimeState: (_ref, _provider, state) => { stored = state; return true; }
  } });
  assert.equal(service.clearRuntimeBlock(REF, 'codex', { evidence: 'manual_admin_clear', scope: 'routing_block' }), true);
  assert.equal(stored.routingBlock, null);
  assert.equal(stored.networkUntil, now + 60000);
  assert.equal(stored.lastFailureKind, 'network_error');
  stored = { authInvalidUntil: now + 60000, lastFailureAt: now - 1000 };
  const old = stored;
  assert.equal(service.clearRuntimeBlock(REF, 'codex', {
    evidence: 'verified_usage_success', usageSnapshot: { source: 'codex_app_server', capturedAt: now }
  }), false);
  assert.equal(stored, old);
});

test('verified usage recovery is wired through account state service and cannot clear billing or network state', () => {
  let stored = { ...runtime(), networkUntil: now + 60000,
    routingBlock: { kind: 'billing_blocked', reason: 'billing_blocked', observedAt: now - 1000 } };
  const service = createAccountStateService({ accountStateIndex: {
    getAccountState: () => ({ runtimeState: stored }),
    upsertRuntimeState: (_ref, _provider, state) => { stored = state; return true; }
  } });
  assert.equal(service.clearRuntimeBlock(REF, 'codex', { evidence: 'verified_usage_success', usageSnapshot: snapshot }), true);
  assert.equal(stored.routingBlock.kind, 'billing_blocked');
  assert.equal(stored.networkUntil, now + 60000);
  assert.deepEqual(stored.modelCooldowns, { network: now + 60000 });
});
