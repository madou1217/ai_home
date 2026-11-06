'use strict';

// 账号行 token 用量的 Go 优先路径：
//   1. Go 成功时行里用 Go 数据并标记 tokenUsageSource='go'
//   2. 60s 缓存内重复构建不再请求（N 行 × 每次重建 ≠ N 次 HTTP）
//   3. Go 失败回落 Node 的缓存+增量逻辑并标记 'node'
//   4. 形状与 Node 的 normalizeAccountTokenUsageValue 完全一致（models 字段名、成本 null）

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GO_TOKEN_USAGE_TTL_MS,
  readGoAccountTokenUsage
} = require('../lib/server/account-token-usage-go-source');
const { __private } = require('../lib/server/webui-account-live');

const ACCOUNT_REF = 'acct_' + 'a1b2c3d4e5f6a7b8c9d0';
const DIMENSIONS = ['day', 'week', 'month', 'total'];

function goPayload(overrides = {}) {
  return {
    day: 120,
    week: 340,
    month: 560,
    total: 900,
    from_ms: 0,
    to_ms: 1,
    cost_known: false,
    models: [
      {
        model: 'gpt-5',
        day: 100,
        week: 300,
        month: 500,
        total: 800,
        dayCostUsd: null,
        weekCostUsd: null,
        monthCostUsd: null,
        totalCostUsd: null
      },
      {
        model: 'gpt-5-mini',
        day: 20,
        week: 40,
        month: 60,
        total: 100,
        dayCostUsd: null,
        weekCostUsd: null,
        monthCostUsd: null,
        totalCostUsd: null
      }
    ],
    ...overrides
  };
}

function nodeUsage() {
  return {
    day: 7,
    week: 8,
    month: 9,
    total: 10,
    models: [
      {
        model: 'node-only-model',
        day: 7,
        week: 8,
        month: 9,
        total: 10,
        dayCostUsd: 0.01,
        weekCostUsd: 0.02,
        monthCostUsd: 0.03,
        totalCostUsd: 0.04
      }
    ]
  };
}

function hostWith(handler) {
  const calls = [];
  return {
    calls,
    isEnabled: () => true,
    getAccountTokenUsage: async (accountRef) => {
      calls.push(accountRef);
      return handler(accountRef);
    }
  };
}

function makeCtx(goCoreSync, cachedUsage) {
  const state = {};
  const ctx = {
    state,
    deps: goCoreSync === undefined ? {} : { goCoreSync },
    fs: null,
    aiHomeDir: ''
  };
  if (cachedUsage) {
    const liveState = __private.getAccountsLiveState(state);
    liveState.tokenUsage = {
      expiresAt: Date.now() + 3_000,
      generatedAt: 1,
      accountGeneratedAt: new Map(),
      value: { [ACCOUNT_REF]: cachedUsage }
    };
  }
  return ctx;
}

// 后台刷新是 Promise 链，等它的 inFlight 比 setImmediate 更确定。
async function waitForRefresh(ctx) {
  const liveState = __private.getAccountsLiveState(ctx.state);
  const entry = liveState.goTokenUsage.get(ACCOUNT_REF);
  if (entry && entry.inFlight) await entry.inFlight;
}

function expectedGoUsage() {
  return {
    day: 120,
    week: 340,
    month: 560,
    total: 900,
    models: [
      {
        model: 'gpt-5',
        day: 100,
        week: 300,
        month: 500,
        total: 800,
        dayCostUsd: null,
        weekCostUsd: null,
        monthCostUsd: null,
        totalCostUsd: null
      },
      {
        model: 'gpt-5-mini',
        day: 20,
        week: 40,
        month: 60,
        total: 100,
        dayCostUsd: null,
        weekCostUsd: null,
        monthCostUsd: null,
        totalCostUsd: null
      }
    ]
  };
}

test('Go 成功时用 Go 数据并标记 go（首次构建先返回 Node，刷新后切换）', async () => {
  const host = hostWith(() => ({ ok: true, data: goPayload() }));
  const ctx = makeCtx(host);

  const first = __private.readAccountTokenUsageWithSource(ctx, ACCOUNT_REF);
  assert.equal(first.source, 'node');
  assert.equal(first.value, null);

  await waitForRefresh(ctx);

  const second = __private.readAccountTokenUsageWithSource(ctx, ACCOUNT_REF);
  assert.equal(second.source, 'go');
  assert.deepEqual(second.value, expectedGoUsage());
  assert.equal(host.calls.length, 1);
});

test('60s 缓存内重复构建不重复请求', async () => {
  const host = hostWith(() => ({ ok: true, data: goPayload() }));
  const ctx = makeCtx(host);

  __private.readAccountTokenUsageWithSource(ctx, ACCOUNT_REF);
  await waitForRefresh(ctx);
  for (let index = 0; index < 5; index += 1) {
    const row = __private.readAccountTokenUsageWithSource(ctx, ACCOUNT_REF);
    assert.equal(row.source, 'go');
  }
  assert.equal(host.calls.length, 1);

  const entry = __private.getAccountsLiveState(ctx.state).goTokenUsage.get(ACCOUNT_REF);
  assert.equal(entry.expiresAt - Date.now() > 0, true);
  assert.equal(entry.expiresAt - Date.now() <= GO_TOKEN_USAGE_TTL_MS, true);
});

test('Go 失败回落 Node 且标记 node，不重复重试', async () => {
  const host = hostWith(() => ({ ok: false, status: 503, errorCode: 'token_usage_unavailable' }));
  const ctx = makeCtx(host, nodeUsage());

  const first = __private.readAccountTokenUsageWithSource(ctx, ACCOUNT_REF);
  assert.equal(first.source, 'node');
  assert.deepEqual(first.value, nodeUsage());

  await waitForRefresh(ctx);

  const second = __private.readAccountTokenUsageWithSource(ctx, ACCOUNT_REF);
  assert.equal(second.source, 'node');
  assert.deepEqual(second.value, nodeUsage());
  // 失败后进入 30s 重试冷却：同一轮重建（以及紧接着的读取）不再打 Go。
  assert.equal(host.calls.length, 1);
});

test('goHost 缺失或未启用时不发请求，直接走 Node', async () => {
  const disabledHost = hostWith(() => ({ ok: true, data: goPayload() }));
  disabledHost.isEnabled = () => false;

  const missing = __private.readAccountTokenUsageWithSource(makeCtx(undefined, nodeUsage()), ACCOUNT_REF);
  assert.equal(missing.source, 'node');
  assert.deepEqual(missing.value, nodeUsage());

  const disabled = __private.readAccountTokenUsageWithSource(makeCtx(disabledHost, nodeUsage()), ACCOUNT_REF);
  assert.equal(disabled.source, 'node');
  assert.equal(disabledHost.calls.length, 0);
});

test('形状对齐：models 字段名与 Node 一致，成本保持 null 不补 0', async () => {
  const host = hostWith(() => ({ ok: true, data: goPayload() }));
  const ctx = makeCtx(host);

  __private.readAccountTokenUsageWithSource(ctx, ACCOUNT_REF);
  await waitForRefresh(ctx);
  const usage = __private.readAccountTokenUsageWithSource(ctx, ACCOUNT_REF).value;

  assert.deepEqual(Object.keys(usage).sort(), ['day', 'models', 'month', 'total', 'week']);
  assert.equal(usage.costKnown, undefined);
  assert.equal(usage.cost_known, undefined);
  for (const model of usage.models) {
    assert.deepEqual(
      Object.keys(model).sort(),
      ['day', 'dayCostUsd', 'model', 'month', 'monthCostUsd', 'total', 'totalCostUsd', 'week', 'weekCostUsd']
    );
    for (const dimension of DIMENSIONS) {
      assert.equal(model[dimension + 'CostUsd'], null);
      assert.notEqual(model[dimension + 'CostUsd'], 0);
    }
  }
});

test('过期后拉取失败：保留旧值但立即回落 node，且不重复请求', async () => {
  let fail = false;
  let calls = 0;
  const host = {
    isEnabled: () => true,
    getAccountTokenUsage: async () => {
      calls += 1;
      return fail
        ? { ok: false, status: 503, errorCode: 'token_usage_unavailable' }
        : { ok: true, data: goPayload() };
    }
  };
  const liveState = { goTokenUsage: new Map() };

  const first = readGoAccountTokenUsage(liveState, ACCOUNT_REF, { goHost: host });
  await first.refresh;
  const entry = liveState.goTokenUsage.get(ACCOUNT_REF);
  assert.equal(entry.available, true);

  // 手动把缓存推到过期；刷新尚未落定时继续用旧值，避免 60s 边界来回跳。
  entry.expiresAt = 0;
  fail = true;
  const stale = readGoAccountTokenUsage(liveState, ACCOUNT_REF, { goHost: host });
  assert.equal(stale.source, 'go');
  await stale.refresh;

  const after = readGoAccountTokenUsage(liveState, ACCOUNT_REF, { goHost: host });
  assert.equal(after.source, 'node');
  assert.equal(after.value, null);
  // 旧值仍保留在条目里（便于观测/下一次成功前对照），但不再被采用。
  assert.deepEqual(entry.value, expectedGoUsage());
  assert.equal(calls, 2);
});
