'use strict';

// 额度统计路由：鉴权/方法/参数边界 + 正常返回形状。
// 窗口重建的算法细节在 test/quota-window-reconstruction.test.js，这里只测接线。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openAppStateDatabase } = require('../lib/server/app-state-store');
const { ensureAccountRefsTable } = require('../lib/server/account-ref-store');
const {
  ensureQuotaWindowTables,
  insertQuotaWindowSample
} = require('../lib/account/quota-window-store');
const {
  handleWebUiAccountQuotaStatsRoutes
} = require('../lib/server/webui-account-quota-stats-routes');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';
const PROVIDER = 'codex';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-quota-stats-route-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seed(dir, { withSamples = true } = {}) {
  const db = openAppStateDatabase(fs, dir, { createIfMissing: true });
  ensureAccountRefsTable(db);
  db.prepare(`
    INSERT INTO account_refs (account_ref, provider, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(ACCOUNT_REF, PROVIDER, 1, 1);
  ensureQuotaWindowTables(db);

  if (withSamples) {
    const closedAnchor = NOW - 6 * HOUR;
    const closedAt = closedAnchor + 5 * HOUR;
    const liveAnchor = NOW - 30 * MINUTE;
    const liveCloseAt = liveAnchor + 5 * HOUR;
    const write = (capturedAtMs, expectedResetAtMs, remainingPct) => insertQuotaWindowSample(
      db,
      ACCOUNT_REF,
      PROVIDER,
      {
        quotaKey: 'rate_limit:primary',
        windowLabel: '5h',
        windowMinutes: 300,
        remainingPct,
        expectedResetAtMs,
        capturedAt: capturedAtMs,
        planType: 'plus'
      }
    );
    write(closedAnchor + 5 * MINUTE, closedAt, 100);
    write(closedAnchor + 2 * HOUR, closedAt, 70);
    write(closedAt - 5 * MINUTE, closedAt, 50);
    write(liveAnchor + 5 * MINUTE, liveCloseAt, 100);
    write(liveAnchor + 20 * MINUTE, liveCloseAt, 90);
  }
  db.close();
}

function createCtx({ method = 'GET', pathname, query = '', dir, deps = {} }) {
  const writes = [];
  const headers = {};
  const url = new URL(`http://127.0.0.1${pathname}${query}`);
  return {
    method,
    pathname,
    url,
    req: { url: `${pathname}${query}` },
    res: {
      setHeader: (name, value) => { headers[name] = value; }
    },
    fs,
    aiHomeDir: dir,
    deps,
    writes,
    headers,
    writeJson: (_res, status, payload) => writes.push({ status, payload })
  };
}

test('不匹配的路径返回 false，不消费请求', async () => {
  const ctx = createCtx({ pathname: '/v0/webui/accounts/codex/' + ACCOUNT_REF + '/other' });
  assert.equal(await handleWebUiAccountQuotaStatsRoutes(ctx), false);
  assert.equal(ctx.writes.length, 0);
});

test('未知账号 404', async (t) => {
  const dir = tmp(t);
  seed(dir, { withSamples: false });
  const ctx = createCtx({
    pathname: `/v0/webui/accounts/${PROVIDER}/acct_ffffffffffffffffffff/quota-stats`,
    dir
  });
  assert.equal(await handleWebUiAccountQuotaStatsRoutes(ctx), true);
  assert.equal(ctx.writes[0].status, 404);
  assert.equal(ctx.writes[0].payload.error, 'account_not_found');
});

test('provider 与账号不符 404', async (t) => {
  const dir = tmp(t);
  seed(dir, { withSamples: false });
  const ctx = createCtx({
    pathname: `/v0/webui/accounts/claude/${ACCOUNT_REF}/quota-stats`,
    dir
  });
  await handleWebUiAccountQuotaStatsRoutes(ctx);
  assert.equal(ctx.writes[0].status, 404);
});

test('非 GET 405，且带 no-store 头', async (t) => {
  const dir = tmp(t);
  seed(dir, { withSamples: false });
  const ctx = createCtx({
    method: 'POST',
    pathname: `/v0/webui/accounts/${PROVIDER}/${ACCOUNT_REF}/quota-stats`,
    dir
  });
  await handleWebUiAccountQuotaStatsRoutes(ctx);
  assert.equal(ctx.writes[0].status, 405);
  assert.equal(ctx.headers['cache-control'], 'no-store');
});

test('window 只做正整数校验：任意档位放行，负数/小数/非数字 400', async (t) => {
  const dir = tmp(t);
  seed(dir, { withSamples: false });

  const accepted = createCtx({
    pathname: `/v0/webui/accounts/${PROVIDER}/${ACCOUNT_REF}/quota-stats`,
    query: '?window=720',
    dir
  });
  await handleWebUiAccountQuotaStatsRoutes(accepted);
  assert.equal(accepted.writes[0].status, 200);

  for (const raw of ['-5', '0.5', 'abc']) {
    const rejected = createCtx({
      pathname: `/v0/webui/accounts/${PROVIDER}/${ACCOUNT_REF}/quota-stats`,
      query: `?window=${raw}`,
      dir
    });
    await handleWebUiAccountQuotaStatsRoutes(rejected);
    assert.equal(rejected.writes[0].status, 400, `window=${raw} 应被拒绝`);
    assert.equal(rejected.writes[0].payload.error, 'invalid_quota_window');
  }
});

test('维度从账号数据派生：12h 账号只显示自己的 12h 维度', async (t) => {
  const dir = tmp(t);
  seed(dir, { withSamples: false });
  const db = openAppStateDatabase(fs, dir, { createIfMissing: true });
  ensureQuotaWindowTables(db);
  const anchor = NOW - 8 * HOUR;
  insertQuotaWindowSample(db, ACCOUNT_REF, PROVIDER, {
    quotaKey: 'rate_limit:12h',
    windowLabel: '12h',
    windowMinutes: 720,
    remainingPct: 80,
    expectedResetAtMs: anchor + 12 * HOUR,
    capturedAt: anchor + MINUTE,
    planType: 'plus'
  });
  db.close();

  const ctx = createCtx({
    pathname: `/v0/webui/accounts/${PROVIDER}/${ACCOUNT_REF}/quota-stats`,
    query: `?to=${NOW}`,
    dir
  });
  await handleWebUiAccountQuotaStatsRoutes(ctx);

  const payload = ctx.writes[0].payload;
  assert.equal(ctx.writes[0].status, 200);
  assert.equal(payload.windowMinutes, 720);
  assert.deepEqual(payload.dimensions.map((dimension) => dimension.windowMinutes), [720]);
  assert.equal(payload.dimensions[0].label, '12h');
  assert.equal(payload.dimensions[0].available, true);
});

test('rangeDays 超上限夹到 90', async (t) => {
  const dir = tmp(t);
  seed(dir, { withSamples: false });
  const ctx = createCtx({
    pathname: `/v0/webui/accounts/${PROVIDER}/${ACCOUNT_REF}/quota-stats`,
    query: '?rangeDays=999',
    dir
  });
  await handleWebUiAccountQuotaStatsRoutes(ctx);
  assert.equal(ctx.writes[0].status, 200);
  assert.equal(ctx.writes[0].payload.range.rangeDays, 90);
});

test('正常返回两个窗口：一个已关闭、一个实时，维度可用性正确', async (t) => {
  const dir = tmp(t);
  seed(dir);
  const ctx = createCtx({
    pathname: `/v0/webui/accounts/${PROVIDER}/${ACCOUNT_REF}/quota-stats`,
    query: `?window=300&rangeDays=1&to=${NOW}`,
    dir
  });
  await handleWebUiAccountQuotaStatsRoutes(ctx);

  const { status, payload } = ctx.writes[0];
  assert.equal(status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.provider, PROVIDER);
  assert.equal(payload.accountRef, ACCOUNT_REF);
  assert.equal(payload.windowMinutes, 300);
  assert.equal(payload.scope.quotaKey, 'rate_limit:primary');

  // 维度只列账号真实有的窗口长度：没有 7天/30天 数据就不该出现（更不该显示成 disabled）。
  assert.deepEqual(payload.dimensions.map((dimension) => dimension.windowMinutes), [300]);
  assert.equal(payload.dimensions[0].available, true);
  assert.equal(payload.dimensions[0].dataState, 'ready');
  assert.equal(payload.dimensions[0].label, '5h');

  assert.equal(payload.windows.length, 2);
  assert.equal(payload.windows[0].consumedPct, 50);
  assert.equal(payload.windows[0].live, false);
  assert.equal(payload.windows[1].consumedPct, 10);
  assert.equal(payload.windows[1].live, true);
  assert.equal(payload.summary.windowCount, 2);
  assert.equal(payload.summary.avgConsumedPct, 30);
  assert.equal(payload.emptyReason, null);
  assert.equal(ctx.headers['cache-control'], 'no-store');
});

test('没有该窗口长度的数据时返回 dimension_unavailable', async (t) => {
  const dir = tmp(t);
  seed(dir, { withSamples: false });
  const ctx = createCtx({
    pathname: `/v0/webui/accounts/${PROVIDER}/${ACCOUNT_REF}/quota-stats`,
    query: '?window=10080&granularity=window',
    dir
  });
  await handleWebUiAccountQuotaStatsRoutes(ctx);

  const { status, payload } = ctx.writes[0];
  assert.equal(status, 200);
  assert.equal(payload.granularity, 'window');
  assert.equal(payload.emptyReason, 'dimension_unavailable');
  assert.deepEqual(payload.windows, []);
  assert.equal(payload.summary.windowCount, 0);
});

test('未指定 window 时回落到第一个可用维度', async (t) => {
  const dir = tmp(t);
  seed(dir);
  const ctx = createCtx({
    pathname: `/v0/webui/accounts/${PROVIDER}/${ACCOUNT_REF}/quota-stats`,
    query: `?to=${NOW}`,
    dir
  });
  await handleWebUiAccountQuotaStatsRoutes(ctx);
  assert.equal(ctx.writes[0].status, 200);
  assert.equal(ctx.writes[0].payload.windowMinutes, 300);
});

test('注入了用量服务时把 tokens 合并进窗口', async (t) => {
  const dir = tmp(t);
  seed(dir);
  const seen = [];
  const deps = {
    modelUsageService: {
      getAccountQuotaWindowUsage: (query) => {
        seen.push(query);
        return query.windows.map((window) => ({
          index: window.index,
          tokens: 1000 * (window.index + 1),
          costUsd: 0.25,
          costKnown: true,
          requestCount: 3
        }));
      }
    }
  };
  const ctx = createCtx({
    pathname: `/v0/webui/accounts/${PROVIDER}/${ACCOUNT_REF}/quota-stats`,
    query: `?window=300&rangeDays=1&to=${NOW}`,
    dir,
    deps
  });
  await handleWebUiAccountQuotaStatsRoutes(ctx);

  const payload = ctx.writes[0].payload;
  assert.equal(seen.length, 1);
  assert.deepEqual(payload.windows.map((window) => window.tokens), [1000, 2000]);
  assert.equal(payload.summary.totalTokens, 3000);
  assert.equal(payload.summary.totalCostUsd, 0.5);
  assert.equal(payload.summary.requestCount, 6);
});

test('granularity=day 按自然日聚合用量，不依赖窗口样本', async (t) => {
  const dir = tmp(t);
  seed(dir, { withSamples: false });
  const seen = [];
  const deps = {
    modelUsageService: {
      getAccountQuotaWindowUsage: (query) => {
        seen.push(query);
        return query.windows.map((window) => ({
          index: window.index,
          tokens: 500,
          costUsd: 0.5,
          costKnown: true,
          requestCount: 2
        }));
      }
    }
  };
  const ctx = createCtx({
    pathname: `/v0/webui/accounts/${PROVIDER}/${ACCOUNT_REF}/quota-stats`,
    query: `?granularity=day&rangeDays=1&to=${NOW}`,
    dir,
    deps
  });
  await handleWebUiAccountQuotaStatsRoutes(ctx);

  const payload = ctx.writes[0].payload;
  assert.equal(ctx.writes[0].status, 200);
  assert.equal(payload.granularity, 'day');
  assert.equal(payload.emptyReason, null);
  assert.equal(seen.length, 1);
  // 1 天范围跨了两个自然日（起点在当天中途），所以是两个部分日桶。
  assert.equal(payload.usageBuckets.length, 2);
  assert.equal(payload.usageBuckets[0].tokens, 500);
  assert.equal(payload.usageSummary.totalTokens, 1000);
  assert.equal(payload.usageSummary.totalCostUsd, 1);
  assert.equal(payload.usageSummary.requestCount, 4);
});

test('granularity=week 按自然周聚合，30 天范围得到 4–6 个桶', async (t) => {
  const dir = tmp(t);
  seed(dir, { withSamples: false });
  const ctx = createCtx({
    pathname: `/v0/webui/accounts/${PROVIDER}/${ACCOUNT_REF}/quota-stats`,
    query: `?granularity=week&rangeDays=30&to=${NOW}`,
    dir
  });
  await handleWebUiAccountQuotaStatsRoutes(ctx);

  const payload = ctx.writes[0].payload;
  assert.equal(ctx.writes[0].status, 200);
  assert.equal(payload.granularity, 'week');
  assert.ok(payload.usageBuckets.length >= 4 && payload.usageBuckets.length <= 6);
  // 周桶必须从本地周一零点开始（getDay(): 0=周日, 1=周一）。
  assert.equal(new Date(payload.usageBuckets[0].bucketStartMs).getDay(), 1);
  assert.equal(new Date(payload.usageBuckets[0].bucketStartMs).getHours(), 0);
});

test('未指定粒度且没有窗口明细时自动给日统计', async (t) => {
  const dir = tmp(t);
  seed(dir, { withSamples: false });
  const ctx = createCtx({
    pathname: `/v0/webui/accounts/${PROVIDER}/${ACCOUNT_REF}/quota-stats`,
    query: `?to=${NOW}`,
    dir
  });
  await handleWebUiAccountQuotaStatsRoutes(ctx);

  const payload = ctx.writes[0].payload;
  assert.equal(ctx.writes[0].status, 200);
  assert.equal(payload.granularity, 'day');
  assert.equal(payload.emptyReason, 'no_usage_in_range');
});

test('非法 granularity 400', async (t) => {
  const dir = tmp(t);
  seed(dir, { withSamples: false });
  const ctx = createCtx({
    pathname: `/v0/webui/accounts/${PROVIDER}/${ACCOUNT_REF}/quota-stats`,
    query: '?granularity=hour',
    dir
  });
  await handleWebUiAccountQuotaStatsRoutes(ctx);
  assert.equal(ctx.writes[0].status, 400);
  assert.equal(ctx.writes[0].payload.error, 'invalid_quota_granularity');
});
