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

test('非法 window 400', async (t) => {
  const dir = tmp(t);
  seed(dir, { withSamples: false });
  const ctx = createCtx({
    pathname: `/v0/webui/accounts/${PROVIDER}/${ACCOUNT_REF}/quota-stats`,
    query: '?window=123',
    dir
  });
  await handleWebUiAccountQuotaStatsRoutes(ctx);
  assert.equal(ctx.writes[0].status, 400);
  assert.equal(ctx.writes[0].payload.error, 'invalid_quota_window');
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

  const fiveHour = payload.dimensions.find((dimension) => dimension.windowMinutes === 300);
  const weekly = payload.dimensions.find((dimension) => dimension.windowMinutes === 10080);
  assert.equal(fiveHour.available, true);
  assert.equal(fiveHour.dataState, 'ready');
  assert.equal(weekly.available, false);
  assert.equal(weekly.dataState, 'empty');

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
    query: '?window=10080',
    dir
  });
  await handleWebUiAccountQuotaStatsRoutes(ctx);

  const { status, payload } = ctx.writes[0];
  assert.equal(status, 200);
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
