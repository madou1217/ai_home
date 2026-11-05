'use strict';

// Go 额度状态叠加层：Node 只展示 Go 的派生结果，不把它写回 account_state。
// 关键行为：Go 失败时清空额度状态但不能连带清掉运行态；签名要能感知额度状态变化。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGoRuntimeOverlay } = require('../lib/server/go-runtime-overlay');

const NODE_REF = 'acct_aaaaaaaaaaaaaaaaaaaa';
const GO_REF = 'acct_bbbbbbbbbbbbbbbbbbbb';

function overlayWith(options = {}) {
  return createGoRuntimeOverlay({
    listAccountRuntime: async () => (options.runtime || []),
    listAccountQuotaStates: async () => (options.quota === undefined ? [] : options.quota),
    readGoRefsByNodeRef: () => ({ [NODE_REF]: GO_REF }),
    fetchTimeoutMs: 50
  });
}

test('quota states are projected onto Node account refs', async () => {
  const overlay = overlayWith({
    runtime: [{ account_ref: GO_REF, blocks: [], models: [], last_success_ms: 10 }],
    quota: [{
      account_ref: GO_REF,
      provider_id: 'codex',
      status: 'pending',
      reason: 'codex_team_plan_pending_rate_limits',
      remaining_pct: null,
      has_numeric_remaining: false,
      captured_at_ms: 1793800000000
    }]
  });
  await overlay.refresh();
  const state = overlay.quotaState(NODE_REF);
  assert.equal(state.status, 'pending');
  assert.equal(state.reason, 'codex_team_plan_pending_rate_limits');
  assert.equal(state.remainingPct, null);
  assert.equal(state.hasNumericRemaining, false);
  assert.equal(state.capturedAtMs, 1793800000000);
  assert.ok(overlay.get(NODE_REF), 'runtime overlay still projects');
});

test('quota state failures do not clear the runtime overlay', async () => {
  const overlay = createGoRuntimeOverlay({
    listAccountRuntime: async () => [{ account_ref: GO_REF, blocks: ['usage_snapshot'], models: [] }],
    listAccountQuotaStates: async () => { throw new Error('boom'); },
    readGoRefsByNodeRef: () => ({ [NODE_REF]: GO_REF }),
    fetchTimeoutMs: 50
  });
  await overlay.refresh();
  assert.ok(overlay.get(NODE_REF));
  assert.equal(overlay.quotaState(NODE_REF), null);
});

test('signature changes when the Go quota state changes', async () => {
  const states = [
    { account_ref: GO_REF, status: 'available', remaining_pct: 42.5, has_numeric_remaining: true, captured_at_ms: 1 },
    { account_ref: GO_REF, status: 'exhausted', remaining_pct: 0, has_numeric_remaining: true, captured_at_ms: 2 }
  ];
  let index = 0;
  const overlay = createGoRuntimeOverlay({
    listAccountRuntime: async () => [],
    listAccountQuotaStates: async () => [states[index]],
    readGoRefsByNodeRef: () => ({ [NODE_REF]: GO_REF }),
    fetchTimeoutMs: 50
  });
  await overlay.refresh();
  const first = overlay.signature(NODE_REF);
  index = 1;
  await overlay.refresh();
  const second = overlay.signature(NODE_REF);
  assert.notEqual(first, second);
  assert.match(first, /available/);
  assert.match(second, /exhausted/);
});

test('quota states without a Node link are ignored', async () => {
  const overlay = createGoRuntimeOverlay({
    listAccountRuntime: async () => [],
    listAccountQuotaStates: async () => [{
      account_ref: 'acct_cccccccccccccccccccc',
      status: 'available',
      remaining_pct: 90,
      has_numeric_remaining: true
    }],
    readGoRefsByNodeRef: () => ({ [NODE_REF]: GO_REF }),
    fetchTimeoutMs: 50
  });
  await overlay.refresh();
  assert.equal(overlay.quotaState(NODE_REF), null);
});
