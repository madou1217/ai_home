'use strict';

// Go 派生的账号运行态叠加层：Node 只展示 Go 的结论，不写回 account_state。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyGoRuntimeOverlay,
  createGoRuntimeOverlay
} = require('../lib/server/go-runtime-overlay');

const NODE_REF = 'acct_aaaaaaaaaaaaaaaaaaaa';
const GO_REF = 'acct_bbbbbbbbbbbbbbbbbbbb';

function overlayWith(runtimeStates) {
  return createGoRuntimeOverlay({
    listAccountRuntime: async () => [],
    listAccountQuotaStates: async () => [],
    listAccountUIStates: async () => [],
    listRuntimeStates: async () => runtimeStates,
    readGoRefsByNodeRef: () => ({ [NODE_REF]: GO_REF }),
    fetchTimeoutMs: 50
  });
}

test('derived runtime state projects onto the Node account ref', async () => {
  const overlay = overlayWith([{
    account_ref: GO_REF,
    status: 'rate_limited',
    reason: '429',
    until_ms: 60_000,
    updated_at: '50000'
  }]);
  await overlay.refresh();
  const state = overlay.runtimeState(NODE_REF);
  assert.equal(state.status, 'rate_limited');
  assert.equal(state.reason, '429');
  assert.equal(state.untilMs, 60_000);
  assert.equal(state.updatedAtMs, 50_000);
});

test('newer Go state overrides the local runtime status', () => {
  const record = {
    accountRef: NODE_REF,
    runtimeStatus: 'healthy',
    stateUpdatedAt: 40_000
  };
  const next = applyGoRuntimeOverlay(record, null, 55_000, {
    status: 'auth_invalid',
    reason: 'expired',
    untilMs: 60_000,
    updatedAtMs: 50_000
  });
  assert.equal(next.runtimeStatus, 'auth_invalid');
  assert.equal(next.runtimeReason, 'expired');
  assert.equal(next.runtimeUntil, 60_000);
  assert.equal(next.runtimeSource, 'go');
});

test('older Go state does not override a newer local status', () => {
  const record = {
    accountRef: NODE_REF,
    runtimeStatus: 'healthy',
    stateUpdatedAt: 70_000
  };
  const next = applyGoRuntimeOverlay(record, null, 55_000, {
    status: 'auth_invalid',
    reason: 'expired',
    untilMs: 60_000,
    updatedAtMs: 50_000
  });
  assert.equal(next.runtimeStatus, 'healthy');
});

test('signature changes when the derived runtime status changes', async () => {
  const before = overlayWith([{
    account_ref: GO_REF, status: 'healthy', reason: '', until_ms: 0, updated_at: '1000'
  }]);
  const after = overlayWith([{
    account_ref: GO_REF, status: 'rate_limited', reason: '429', until_ms: 9000, updated_at: '2000'
  }]);
  await before.refresh();
  await after.refresh();
  assert.notEqual(before.signature(NODE_REF), after.signature(NODE_REF));
});
