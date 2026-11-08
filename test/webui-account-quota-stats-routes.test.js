'use strict';

// 额度统计路由：切流后只做账号校验 / 参数翻译 / Go 调用 / 契约映射。
//
// 这里锁四类行为：
//   · 账号与参数边界（404 / 400 / 405），Go 不会被无意义地打到；
//   · Go 不可用**必须 503**，不能回落到第二套算法（总账第 9 条的回滚原因）；
//   · 请求参数确实按 Go 的契约翻译（window / range_days / scope / granularity）；
//   · 日/周视图的桶形状（index、bucketStartMs、costKnown）与空态。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openAppStateDatabase } = require('../lib/server/app-state-store');
const { ensureAccountRefsTable } = require('../lib/server/account-ref-store');
const {
  handleWebUiAccountQuotaStatsRoutes
} = require('../lib/server/webui-account-quota-stats-routes');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';
const PROVIDER = 'codex';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-quota-stats-route-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seed(dir, provider = PROVIDER) {
  const db = openAppStateDatabase(fs, dir, { createIfMissing: true });
  ensureAccountRefsTable(db);
  db.prepare(`
    INSERT INTO account_refs (account_ref, provider, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(ACCOUNT_REF, provider, 1, 1);
  db.close();
}

function goWindowStats(overrides = {}) {
  return {
    generatedAtMs: 1000,
    range: { fromMs: 0, toMs: 1000, rangeDays: 30 },
    dimensions: [
      {
        windowMinutes: 300,
        label: '5h',
        available: true,
        dataState: 'ready',
        scopes: [{ quotaKey: 'rate_limit:primary', label: '5h', sampleCount: 2, lastCapturedAtMs: 900, synthetic: false }]
      }
    ],
    windowMinutes: 300,
    scope: { quotaKey: 'rate_limit:primary', label: '5h', sampleCount: 2, lastCapturedAtMs: 900, synthetic: false },
    current: { remainingPct: 40, resetAtMs: 2000, capturedAtMs: 900 },
    summary: {
      windowCount: 1,
      coveredWindowCount: 1,
      totalTokens: 3000,
      totalCostUsd: 0.5,
      costKnown: true,
      requestCount: 6,
      avgConsumedPct: 60,
      maxConsumedPct: 60,
      minConsumedPct: 60,
      avgTokensPerWindow: 3000,
      avgCostUsdPerWindow: 0.5,
      lastResetAtMs: 0,
      nextCloseAtMs: 2000
    },
    windows: [{ index: 0, anchorAtMs: 1000, closeAtMs: 2000, consumedPct: 60, tokens: 3000 }],
    emptyReason: null,
    costSupported: true,
    ...overrides
  };
}

function createGoHost(overrides = {}) {
  const calls = { quota: [], buckets: [] };
  const host = {
    getAccountQuotaStats: async (ref, query) => {
      calls.quota.push({ ref, query });
      const value = overrides.quota;
      return typeof value === 'function' ? value(ref, query) : (value || { ok: true, data: goWindowStats() });
    },
    getUsageBuckets: async (ref, query) => {
      calls.buckets.push({ ref, query });
      const value = overrides.buckets;
      return typeof value === 'function' ? value(ref, query) : (value || { ok: true, data: { buckets: [] } });
    }
  };
  if (overrides.withoutBuckets) delete host.getUsageBuckets;
  return { host, calls };
}

function createCtx({ method = 'GET', pathname, query = '', dir, deps = {} }) {
  const writes = [];
  const headers = {};
  return {
    method,
    pathname,
    url: new URL(`http://127.0.0.1${pathname}${query}`),
    req: { url: `${pathname}${query}` },
    res: { setHeader: (name, value) => { headers[name] = value; } },
    fs,
    aiHomeDir: dir,
    deps,
    writes,
    headers,
    writeJson: (_res, status, payload) => writes.push({ status, payload })
  };
}

function accountPath(provider = PROVIDER, accountRef = ACCOUNT_REF) {
  return `/v0/webui/accounts/${provider}/${accountRef}/quota-stats`;
}

test('不匹配的路径返回 false，不消费请求', async () => {
  const ctx = createCtx({ pathname: accountPath() + '/other' });
  assert.equal(await handleWebUiAccountQuotaStatsRoutes(ctx), false);
  assert.equal(ctx.writes.length, 0);
});

test('未知账号 404，且不调用 Go', async (t) => {
  const dir = tmp(t);
  seed(dir);
  const { host, calls } = createGoHost();
  const ctx = createCtx({
    pathname: accountPath(PROVIDER, 'acct_ffffffffffffffffffff'),
    dir,
    deps: { goCoreSync: host }
  });
  assert.equal(await handleWebUiAccountQuotaStatsRoutes(ctx), true);
  assert.equal(ctx.writes[0].status, 404);
  assert.equal(ctx.writes[0].payload.error, 'account_not_found');
  assert.equal(calls.quota.length, 0);
});

test('provider 与账号不符 404', async (t) => {
  const dir = tmp(t);
  seed(dir);
  const { host } = createGoHost();
  const ctx = createCtx({ pathname: accountPath('claude'), dir, deps: { goCoreSync: host } });
  await handleWebUiAccountQuotaStatsRoutes(ctx);
  assert.equal(ctx.writes[0].status, 404);
});

test('非 GET 405，且带 no-store 头', async (t) => {
  const dir = tmp(t);
  seed(dir);
  const { host } = createGoHost();
  const ctx = createCtx({ method: 'POST', pathname: accountPath(), dir, deps: { goCoreSync: host } });
  await handleWebUiAccountQuotaStatsRoutes(ctx);
  assert.equal(ctx.writes[0].status, 405);
  assert.equal(ctx.headers['cache-control'], 'no-store');
});

test('window 只做正整数校验：任意档位放行，负数/小数/非数字 400', async (t) => {
  const dir = tmp(t);
  seed(dir);
  const { host, calls } = createGoHost();
  const accepted = createCtx({
    pathname: accountPath(),
    query: '?window=720',
    dir,
    deps: { goCoreSync: host }
  });
  await handleWebUiAccountQuotaStatsRoutes(accepted);
  assert.equal(accepted.writes[0].status, 200);
  assert.equal(calls.quota[0].query.windowMinutes, 720);

  for (const raw of ['-5', '0.5', 'abc', '0']) {
    const rejected = createCtx({
      pathname: accountPath(),
      query: `?window=${raw}`,
      dir,
      deps: { goCoreSync: host }
    });
    await handleWebUiAccountQuotaStatsRoutes(rejected);
    assert.equal(rejected.writes[0].status, 400, `window=${raw} 应被拒绝`);
    assert.equal(rejected.writes[0].payload.error, 'invalid_quota_window');
  }
  assert.equal(calls.quota.length, 1, '参数非法的请求不该打到 Go');
});

test('非法 granularity 400', async (t) => {
  const dir = tmp(t);
  seed(dir);
  const { host } = createGoHost();
  const ctx = createCtx({
    pathname: accountPath(),
    query: '?granularity=hour',
    dir,
    deps: { goCoreSync: host }
  });
  await handleWebUiAccountQuotaStatsRoutes(ctx);
  assert.equal(ctx.writes[0].status, 400);
  assert.equal(ctx.writes[0].payload.error, 'invalid_quota_granularity');
});

test('Go 未装配时 503，不回落到本地算法', async (t) => {
  const dir = tmp(t);
  seed(dir);
  const ctx = createCtx({ pathname: accountPath(), dir, deps: {} });
  await handleWebUiAccountQuotaStatsRoutes(ctx);
  assert.equal(ctx.writes[0].status, 503);
  assert.equal(ctx.writes[0].payload.error, 'go_core_unavailable');
});

test('Go 返回失败时 503，并把 Go 的错误码透出', async (t) => {
  const dir = tmp(t);
  seed(dir);
  const { host } = createGoHost({ quota: { ok: false, status: 500, errorCode: 'quota_stats_unavailable' } });
  const ctx = createCtx({ pathname: accountPath(), dir, deps: { goCoreSync: host } });
  await handleWebUiAccountQuotaStatsRoutes(ctx);
  assert.equal(ctx.writes[0].status, 503);
  assert.equal(ctx.writes[0].payload.error, 'quota_stats_unavailable');
});

test('窗口视图：参数按 Go 契约翻译，响应 snake→camel 且不请求时间桶', async (t) => {
  const dir = tmp(t);
  seed(dir);
  const { host, calls } = createGoHost();
  const ctx = createCtx({
    pathname: accountPath(),
    query: '?window=300&range_days=7&scope=rate_limit%3Aprimary',
    dir,
    deps: { goCoreSync: host }
  });
  await handleWebUiAccountQuotaStatsRoutes(ctx);

  const { status, payload } = ctx.writes[0];
  assert.equal(status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.provider, PROVIDER);
  assert.equal(payload.accountRef, ACCOUNT_REF);
  assert.equal(payload.granularity, 'window');
  assert.equal(payload.windowMinutes, 300);
  assert.equal(payload.range.rangeDays, 30);
  assert.equal(payload.summary.totalTokens, 3000);
  assert.equal(payload.summary.costKnown, true);
  assert.equal(payload.windows.length, 1);
  assert.deepEqual(payload.usageBuckets, [], '窗口视图不该带日周桶');
  assert.equal(payload.usageSummary, null);

  assert.deepEqual(calls.quota[0], {
    ref: ACCOUNT_REF,
    query: { windowMinutes: 300, rangeDays: 7, scope: 'rate_limit:primary' }
  });
  assert.equal(calls.buckets.length, 0);
});

test('rangeDays 超上限夹到 90，range_days 与 rangeDays 等价', async (t) => {
  const dir = tmp(t);
  seed(dir);
  const { host, calls } = createGoHost();
  for (const query of ['?rangeDays=999', '?range_days=999']) {
    const ctx = createCtx({ pathname: accountPath(), query, dir, deps: { goCoreSync: host } });
    await handleWebUiAccountQuotaStatsRoutes(ctx);
    assert.equal(ctx.writes[0].status, 200);
  }
  assert.deepEqual(calls.quota.map((call) => call.query.rangeDays), [90, 90]);
});

test('未指定粒度且没有可用窗口时给日统计，并接 Go 的时间桶', async (t) => {
  const dir = tmp(t);
  seed(dir);
  const { host, calls } = createGoHost({
    quota: { ok: true, data: goWindowStats({ dimensions: [], windowMinutes: 0, scope: null, windows: [], emptyReason: 'dimension_unavailable' }) },
    buckets: {
      ok: true,
      data: {
        buckets: [
          { index: 0, start_ms: 100, end_ms: 200, bucket_start_ms: 100, tokens: 500, request_count: 2 },
          { index: 1, start_ms: 200, end_ms: 300, bucket_start_ms: 200, tokens: 0, request_count: 0 }
        ]
      }
    }
  });
  const ctx = createCtx({ pathname: accountPath(), query: '?rangeDays=7', dir, deps: { goCoreSync: host } });
  await handleWebUiAccountQuotaStatsRoutes(ctx);

  const { status, payload } = ctx.writes[0];
  assert.equal(status, 200);
  assert.equal(payload.granularity, 'day');
  assert.equal(payload.usageBuckets.length, 2);
  assert.deepEqual(payload.usageBuckets[0], {
    index: 0,
    startMs: 100,
    endMs: 200,
    bucketStartMs: 100,
    tokens: 500,
    costUsd: null,
    costKnown: false,
    requestCount: 2
  });
  assert.equal(payload.usageSummary.bucketCount, 2);
  assert.equal(payload.usageSummary.totalTokens, 500);
  assert.equal(payload.usageSummary.totalCostUsd, null);
  assert.equal(payload.usageSummary.costKnown, false);
  // 日视图里 Go 的窗口空态不能冒充「没有用量」。
  assert.equal(payload.emptyReason, null);

  assert.equal(calls.buckets.length, 1);
  assert.equal(calls.buckets[0].ref, ACCOUNT_REF);
  assert.equal(calls.buckets[0].query.granularity, 'day');
  const spanDays = (Date.parse(calls.buckets[0].query.toISO) - Date.parse(calls.buckets[0].query.fromISO)) / 86400000;
  assert.ok(spanDays > 6.9 && spanDays < 7.1, `桶区间应覆盖 7 天，实际 ${spanDays}`);
});

test('日视图没有任何用量时 emptyReason=no_usage_in_range', async (t) => {
  const dir = tmp(t);
  seed(dir);
  const { host } = createGoHost({
    quota: { ok: true, data: goWindowStats({ dimensions: [], windowMinutes: 0, scope: null }) },
    buckets: { ok: true, data: { buckets: [{ index: 0, start_ms: 100, end_ms: 200, bucket_start_ms: 100, tokens: 0, request_count: 0 }] } }
  });
  const ctx = createCtx({
    pathname: accountPath(),
    query: '?granularity=day',
    dir,
    deps: { goCoreSync: host }
  });
  await handleWebUiAccountQuotaStatsRoutes(ctx);
  assert.equal(ctx.writes[0].payload.emptyReason, 'no_usage_in_range');
  assert.equal(ctx.writes[0].payload.usageSummary.totalTokens, 0);
});

test('时间桶接口失败时 503，不返回半个响应', async (t) => {
  const dir = tmp(t);
  seed(dir);
  const { host } = createGoHost({
    quota: { ok: true, data: goWindowStats({ dimensions: [], windowMinutes: 0, scope: null }) },
    buckets: { ok: false, status: 500, errorCode: 'usage_buckets_failed' }
  });
  const ctx = createCtx({ pathname: accountPath(), query: '?granularity=day', dir, deps: { goCoreSync: host } });
  await handleWebUiAccountQuotaStatsRoutes(ctx);
  assert.equal(ctx.writes[0].status, 503);
  assert.equal(ctx.writes[0].payload.error, 'usage_buckets_failed');
});

test('时间桶方法缺失时 503（Go 版本落后于 Node）', async (t) => {
  const dir = tmp(t);
  seed(dir);
  const { host } = createGoHost({
    quota: { ok: true, data: goWindowStats({ dimensions: [], windowMinutes: 0, scope: null }) },
    withoutBuckets: true
  });
  const ctx = createCtx({ pathname: accountPath(), query: '?granularity=day', dir, deps: { goCoreSync: host } });
  await handleWebUiAccountQuotaStatsRoutes(ctx);
  assert.equal(ctx.writes[0].status, 503);
  assert.equal(ctx.writes[0].payload.error, 'go_core_unavailable');
});

test('format=go 原样返回 Go 结果，供对拍取证', async (t) => {
  const dir = tmp(t);
  seed(dir);
  const { host, calls } = createGoHost();
  const ctx = createCtx({ pathname: accountPath(), query: '?format=go', dir, deps: { goCoreSync: host } });
  await handleWebUiAccountQuotaStatsRoutes(ctx);
  assert.equal(ctx.writes[0].status, 200);
  assert.equal(ctx.writes[0].payload.ok, true);
  assert.equal(ctx.writes[0].payload.go.summary.totalTokens, 3000);
  assert.equal(ctx.writes[0].payload.go.usageBuckets, undefined);
  assert.equal(calls.buckets.length, 0);
});
