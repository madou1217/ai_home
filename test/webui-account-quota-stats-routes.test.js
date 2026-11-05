'use strict';

// 额度统计路由：鉴权/方法/参数边界 + 契约映射。
//
// 计算已全部在 Go（窗口重建、用量聚合、成本）。这里只验证 Node 这一层的职责：
// 账号校验、参数翻译、snake_case → camelCase、以及 Go 不可用时的失败语义。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openAppStateDatabase } = require('../lib/server/app-state-store');
const { ensureAccountRefsTable } = require('../lib/server/account-ref-store');
const { ensureQuotaWindowTables } = require('../lib/account/quota-window-store');
const {
  handleWebUiAccountQuotaStatsRoutes,
  buildQuotaStatsSearch
} = require('../lib/server/webui-account-quota-stats-routes');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';
const PROVIDER = 'codex';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-quota-stats-route-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seed(dir) {
  const db = openAppStateDatabase(fs, dir, { createIfMissing: true });
  ensureAccountRefsTable(db);
  db.prepare(
    'INSERT INTO account_refs (account_ref, provider, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ).run(ACCOUNT_REF, PROVIDER, 1, 1);
  ensureQuotaWindowTables(db);
  db.close();
}

function createCtx({ method = 'GET', pathname, query = '', dir, deps = {} }) {
  const writes = [];
  const headers = {};
  const url = new URL('http://127.0.0.1' + pathname + query);
  return {
    method,
    pathname,
    url,
    req: { url: pathname + query },
    res: { setHeader: (name, value) => { headers[name] = value; } },
    fs,
    aiHomeDir: dir,
    deps,
    writes,
    headers,
    writeJson: (_res, status, payload) => writes.push({ status, payload })
  };
}

// 假的 Go 宿主：记录调用参数，返回预置响应。
function createGoHost(response = { ok: true, status: 200, data: { data: {} } }, { enabled = true } = {}) {
  const calls = [];
  return {
    calls,
    isEnabled: () => enabled,
    getQuotaStats: async (accountRef, query) => {
      calls.push({ accountRef, query });
      return response;
    }
  };
}

function goPayload() {
  return {
    data: {
      generated_at_ms: 1000,
      range: { from_ms: 10, to_ms: 20, range_days: 7 },
      dimensions: [
        {
          window_minutes: 300,
          label: '5h',
          available: true,
          data_state: 'ready',
          scopes: [
            { quota_key: 'rate_limit:primary', label: '5h', sample_count: 2, last_captured_at_ms: 900, synthetic: false }
          ]
        }
      ],
      window_minutes: 300,
      scope: { quota_key: 'rate_limit:primary', label: '5h', sample_count: 2, last_captured_at_ms: 900, synthetic: false },
      current: { remaining_pct: 42.5, reset_at_ms: 500, captured_at_ms: 400 },
      summary: {
        window_count: 1,
        covered_window_count: 1,
        total_tokens: 1500,
        total_cost_usd: 0.00625,
        cost_known: true,
        request_count: 3,
        avg_consumed_pct: 55.5,
        max_consumed_pct: 55.5,
        min_consumed_pct: 55.5,
        avg_tokens_per_window: 1500,
        avg_cost_usd_per_window: 0.00625,
        last_reset_at_ms: 300,
        next_close_at_ms: 500
      },
      windows: [
        {
          index: 0,
          anchor_at_ms: 100,
          close_at_ms: 500,
          scheduled_close_at_ms: 500,
          truncated: false,
          live: true,
          remaining_start_pct: 100,
          remaining_end_pct: 42.5,
          remaining_min_pct: 42.5,
          consumed_pct: 57.5,
          peak_consumed_pct: 57.5,
          start_estimated: false,
          sample_count: 2,
          observed_from_ms: 120,
          observed_to_ms: 400,
          source: 'samples',
          confidence: 'high',
          reset_kind: 'cycle_rollover',
          classification: 'natural',
          plan_type: 'plus',
          approximate_close: false,
          anchor_estimated: false,
          tokens: 1500,
          cost_usd: 0.00625,
          cost_known: true,
          request_count: 3
        }
      ],
      empty_reason: '',
      cost_supported: true
    }
  };
}

test('不匹配的路径返回 false，不消费请求', async () => {
  const ctx = createCtx({ pathname: '/v0/webui/accounts/codex/' + ACCOUNT_REF + '/other' });
  assert.equal(await handleWebUiAccountQuotaStatsRoutes(ctx), false);
  assert.equal(ctx.writes.length, 0);
});

test('未知账号 404', async (t) => {
  const dir = tmp(t);
  const ctx = createCtx({
    pathname: '/v0/webui/accounts/codex/acct_ffffffffffffffffffff/quota-stats',
    dir,
    deps: { goCoreSync: createGoHost() }
  });
  await handleWebUiAccountQuotaStatsRoutes(ctx);
  assert.equal(ctx.writes[0].status, 404);
  assert.equal(ctx.writes[0].payload.error, 'account_not_found');
});

test('provider 与账号不符 404', async (t) => {
  const dir = tmp(t);
  seed(dir);
  const ctx = createCtx({
    pathname: '/v0/webui/accounts/claude/' + ACCOUNT_REF + '/quota-stats',
    dir,
    deps: { goCoreSync: createGoHost() }
  });
  await handleWebUiAccountQuotaStatsRoutes(ctx);
  assert.equal(ctx.writes[0].status, 404);
});

test('非 GET 405，且带 no-store 头', async (t) => {
  const dir = tmp(t);
  const ctx = createCtx({
    method: 'POST',
    pathname: '/v0/webui/accounts/codex/' + ACCOUNT_REF + '/quota-stats',
    dir
  });
  await handleWebUiAccountQuotaStatsRoutes(ctx);
  assert.equal(ctx.writes[0].status, 405);
  assert.equal(ctx.headers['cache-control'], 'no-store');
  assert.equal(ctx.headers['x-content-type-options'], 'nosniff');
});

// 没有本地回落：Go 不可用时明确 503，而不是悄悄换一套算法。
test('Go Core 不可用时 503', async (t) => {
  const dir = tmp(t);
  seed(dir);
  for (const deps of [{}, { goCoreSync: null }, { goCoreSync: createGoHost({}, { enabled: false }) }]) {
    const ctx = createCtx({
      pathname: '/v0/webui/accounts/codex/' + ACCOUNT_REF + '/quota-stats',
      dir,
      deps
    });
    await handleWebUiAccountQuotaStatsRoutes(ctx);
    assert.equal(ctx.writes[0].status, 503);
    assert.equal(ctx.writes[0].payload.error, 'go_core_required');
  }
});

test('Go 400 → invalid_quota_stats_query', async (t) => {
  const dir = tmp(t);
  seed(dir);
  const ctx = createCtx({
    pathname: '/v0/webui/accounts/codex/' + ACCOUNT_REF + '/quota-stats',
    query: '?window=999',
    dir,
    deps: { goCoreSync: createGoHost({ ok: false, status: 400, errorCode: 'invalid_quota_stats_query' }) }
  });
  await handleWebUiAccountQuotaStatsRoutes(ctx);
  assert.equal(ctx.writes[0].status, 400);
  assert.equal(ctx.writes[0].payload.error, 'invalid_quota_stats_query');
});

test('Go 500 → 502', async (t) => {
  const dir = tmp(t);
  seed(dir);
  const ctx = createCtx({
    pathname: '/v0/webui/accounts/codex/' + ACCOUNT_REF + '/quota-stats',
    dir,
    deps: { goCoreSync: createGoHost({ ok: false, status: 500, errorCode: 'usage_stats_failed' }) }
  });
  await handleWebUiAccountQuotaStatsRoutes(ctx);
  assert.equal(ctx.writes[0].status, 502);
  assert.equal(ctx.writes[0].payload.error, 'usage_stats_failed');
});

test('成功响应按 WebUI 契约映射，并把参数翻译后交给 Go', async (t) => {
  const dir = tmp(t);
  seed(dir);
  const goHost = createGoHost({ ok: true, status: 200, data: goPayload() });
  const ctx = createCtx({
    pathname: '/v0/webui/accounts/codex/' + ACCOUNT_REF + '/quota-stats',
    query: '?window=300&scope=rate_limit%3Aprimary&rangeDays=7',
    dir,
    deps: { goCoreSync: goHost }
  });
  await handleWebUiAccountQuotaStatsRoutes(ctx);

  assert.deepEqual(goHost.calls, [{
    accountRef: ACCOUNT_REF,
    query: { window: '300', scope: 'rate_limit:primary', rangeDays: '7' }
  }]);

  const { status, payload } = ctx.writes[0];
  assert.equal(status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.provider, 'codex');
  assert.equal(payload.accountRef, ACCOUNT_REF);
  assert.equal(payload.generatedAtMs, 1000);
  assert.deepEqual(payload.range, { fromMs: 10, toMs: 20, rangeDays: 7 });
  assert.equal(payload.windowMinutes, 300);
  assert.equal(payload.costSupported, true);
  // 空原因用 null，不是空串
  assert.equal(payload.emptyReason, null);
  assert.equal(payload.dimensions[0].windowMinutes, 300);
  assert.equal(payload.dimensions[0].dataState, 'ready');
  assert.equal(payload.dimensions[0].scopes[0].quotaKey, 'rate_limit:primary');
  assert.equal(payload.dimensions[0].scopes[0].lastCapturedAtMs, 900);
  assert.equal(payload.scope.quotaKey, 'rate_limit:primary');
  assert.equal(payload.current.remainingPct, 42.5);
  assert.equal(payload.summary.totalCostUsd, 0.00625);
  assert.equal(payload.summary.costKnown, true);
  assert.equal(payload.summary.avgCostUsdPerWindow, 0.00625);

  const row = payload.windows[0];
  const required = [
    'index', 'anchorAtMs', 'closeAtMs', 'scheduledCloseAtMs', 'truncated', 'live',
    'remainingStartPct', 'remainingEndPct', 'remainingMinPct', 'consumedPct',
    'peakConsumedPct', 'startEstimated', 'sampleCount', 'observedFromMs', 'observedToMs',
    'tokens', 'costUsd', 'costKnown', 'requestCount', 'source', 'confidence',
    'resetKind', 'classification', 'planType', 'approximateClose', 'anchorEstimated'
  ];
  for (const key of required) {
    assert.ok(Object.prototype.hasOwnProperty.call(row, key), '窗口缺少字段 ' + key);
  }
  assert.equal(row.resetKind, 'cycle_rollover');
  assert.equal(row.costUsd, 0.00625);
});

test('buildQuotaStatsSearch 只翻译前端真正会发的参数', () => {
  assert.equal(
    buildQuotaStatsSearch({ window: 10080, scope: ' rate_limit:secondary ', rangeDays: 30 }),
    'window=10080&scope=rate_limit%3Asecondary&range_days=30'
  );
  assert.equal(buildQuotaStatsSearch({ window: 'abc', rangeDays: -1 }), '');
  assert.equal(buildQuotaStatsSearch({}), '');
  // to 是调试参数，前端不发，Go 也不接受。
  assert.equal(buildQuotaStatsSearch({ to: 123 }), '');
});

