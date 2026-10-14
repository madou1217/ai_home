'use strict';

// Cline Pass 额度插件（lib/usage/quota/plugins/cline.js）：
// 服务端权威用量（/users/me/plan/usage-limits）→ entries[] 的映射、错误分支与 401 重试。
//
// 关键回归：曾用 `/users/{uid}/usages` 逐条累加算窗口用量。该接口翻页游标上游不生效、
// 单页被夹到 200 条，只能扫到最近十几分钟 → used 严重低估、remaining 虚高。现在只用
// 服务端算好的 percentUsed，并且**不允许**再回到 /usages 聚合。

const test = require('node:test');
const assert = require('node:assert/strict');

const plugin = require('../lib/usage/quota/plugins/cline');
const { clineAuth, providersDocument } = require('./helpers/cline-credential');

const { readUsageLimits, readPlanEntitlement, summarizeUsageWindows } = plugin.__private;

const CAPS = {
  last5HoursUsageCostUSDPerUser: 1_000_000_000,
  last7daysUsageCostUSDPerUser: 2_500_000_000,
  last30daysUsageCostUSDPerUser: 5_000_000_000
};

function planPayload(overrides = {}) {
  return {
    data: {
      userId: 'usr-test-1',
      currentPeriodStart: '2026-10-14T05:30:04Z',
      currentPeriodEnd: '2026-11-14T05:30:04Z',
      plan: {
        displayName: 'Cline Pass (Monthly)',
        entitlements: { cline_pass: { enabled: true, inferenceCapThreshold: CAPS } }
      },
      ...overrides
    }
  };
}

function limitsPayload(limits = [
  { type: 'five_hour', percentUsed: 24, resetsAt: '2026-10-14T15:42:36.725450285Z' },
  { type: 'weekly', percentUsed: 21, resetsAt: '2026-10-21T05:42:22.727346655Z' },
  { type: 'monthly', percentUsed: 10, resetsAt: '2026-11-13T05:42:22.729160335Z' }
]) {
  return { data: { limits } };
}

function createProbeFixture(options = {}) {
  const requests = [];
  const responses = options.responses || {};
  const record = options.record === undefined
    ? { provider: 'cline', env: {}, nativeAuth: { auth: providersDocument('cline-pass', clineAuth('cline-user-1', 1)) } }
    : options.record;
  const refreshCalls = [];
  const probe = plugin.createProbe({
    fs: {},
    aiHomeDir: '/tmp/aih-cline-quota-test',
    usageSnapshotSchemaVersion: 2,
    processObj: { env: {} },
    readAccountCredentialRecord: () => record,
    resolveAccountEgressRequestOptions: async () => ({ ok: true, options: {} }),
    refreshClineAccessToken: async (...args) => {
      refreshCalls.push(args);
      return options.refreshResult || { ok: true, refreshed: true, accessToken: 'workos:refreshed-token' };
    },
    fetchWithTimeout: async (url) => {
      requests.push(url);
      const match = Object.keys(responses).find((key) => url.includes(key));
      if (!match) return { ok: false, status: 404, json: async () => ({}) };
      const value = responses[match];
      const resolved = typeof value === 'function' ? value(url) : value;
      return { ok: resolved.status >= 200 && resolved.status < 300, status: resolved.status, json: async () => resolved.body };
    }
  });
  return { probe, requests, refreshCalls };
}

test('readUsageLimits 把上游 limits[] 折成按 type 索引的权威用量', () => {
  const byType = readUsageLimits(limitsPayload());
  assert.deepEqual(Object.keys(byType).sort(), ['five_hour', 'monthly', 'weekly']);
  assert.equal(byType.five_hour.percentUsed, 24);
  assert.equal(byType.weekly.percentUsed, 21);
  assert.equal(byType.monthly.percentUsed, 10);
  assert.equal(Number.isFinite(byType.five_hour.resetsAtMs), true);
  assert.deepEqual(readUsageLimits({ data: {} }), {});
  assert.deepEqual(readUsageLimits(null), {});
});

test('readPlanEntitlement 把 1e-8 单位的上限折成美元，并读出套餐身份', () => {
  const entitlement = readPlanEntitlement(planPayload());
  assert.equal(entitlement.capsUsd['5h'], 10);
  assert.equal(entitlement.capsUsd['7days'], 25);
  assert.equal(entitlement.capsUsd['30days'], 50);
  assert.equal(entitlement.planName, 'Cline Pass (Monthly)');
  assert.equal(entitlement.userId, 'usr-test-1');
  assert.equal(entitlement.periodEndMs, Date.parse('2026-11-14T05:30:04Z'));
});

test('readPlanEntitlement 在 entitlement 缺席/停用时返回 null，不臆造额度', () => {
  assert.equal(readPlanEntitlement({ data: { plan: {} } }), null);
  assert.equal(readPlanEntitlement({ data: { plan: { entitlements: { cline_pass: { enabled: false } } } } }), null);
  assert.equal(readPlanEntitlement({ data: { plan: { entitlements: { cline_pass: { enabled: true } } } } }), null);
});

test('summarizeUsageWindows 用服务端 percentUsed 反推剩余，并用上游 resetsAt', () => {
  const nowMs = Date.parse('2026-10-14T15:00:00Z');
  const summary = summarizeUsageWindows({
    usageByType: readUsageLimits(limitsPayload()),
    capsUsd: readPlanEntitlement(planPayload()).capsUsd,
    nowMs
  });
  assert.deepEqual(summary.missingWindows, []);
  assert.deepEqual(summary.entries.map((entry) => entry.bucket), ['5h', '7days', '30days']);
  assert.deepEqual(summary.entries.map((entry) => entry.remainingPct), [76, 79, 90]);
  const fiveHour = summary.entries[0];
  assert.equal(fiveHour.window, '5h');
  assert.equal(fiveHour.windowMinutes, 300);
  assert.equal(fiveHour.totalUnits, 10);
  assert.equal(fiveHour.usedUnits, 2.4);
  assert.equal(fiveHour.remainingUnits, 7.6);
  assert.equal(fiveHour.unitType, 'usd');
  assert.equal(fiveHour.resetAtMs, Date.parse('2026-10-14T15:42:36.725450285Z'));
  assert.equal(fiveHour.resetIn, '42m');
});

test('summarizeUsageWindows 缺窗口就不产出条目（宁可 Unknown，不臆造）', () => {
  const summary = summarizeUsageWindows({
    usageByType: readUsageLimits(limitsPayload([{ type: 'five_hour', percentUsed: 50, resetsAt: '' }])),
    capsUsd: readPlanEntitlement(planPayload()).capsUsd,
    nowMs: Date.parse('2026-10-14T15:00:00Z')
  });
  assert.deepEqual(summary.entries.map((entry) => entry.bucket), ['5h']);
  assert.deepEqual(summary.missingWindows, ['7days', '30days']);
  assert.equal(summary.entries[0].resetAtMs, 0);
  assert.equal(summary.entries[0].resetIn, '');
});


test('probe 走服务端权威接口，产出可被注册表信任的快照', async () => {
  const fixture = createProbeFixture({
    responses: {
      'plan/usage-limits': { status: 200, body: limitsPayload() },
      'users/me/plan': { status: 200, body: planPayload() }
    }
  });
  const result = await fixture.probe.probe('acct_3e25a1db0334a63e7eef', 5_000);
  assert.equal(result.error, undefined);
  const snapshot = result.snapshot;
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.kind, 'cline_pass_usage');
  assert.equal(snapshot.source, 'cline_plan_usages_api');
  assert.equal(snapshot.entries.length, 3);
  assert.equal(snapshot.account.planName, 'Cline Pass (Monthly)');
  assert.equal(snapshot.account.userId, 'usr-test-1');
  assert.equal(snapshot.coverage.source, 'plan_usage_limits');
  // 只允许这两个权威端点：不许回退到 /usages 聚合（游标不生效会低估用量）。
  assert.deepEqual(
    fixture.requests.map((url) => url.replace('https://api.cline.bot/api/v1', '')).sort(),
    ['/users/me/plan', '/users/me/plan/usage-limits']
  );
  assert.equal(fixture.requests.some((url) => url.includes('/usages')), false);
});

test('probe 在 API Key 账号上没有 Cline Pass 额度，明确报 api_key_mode_not_applicable', async () => {
  const fixture = createProbeFixture({
    record: {
      provider: 'cline',
      env: { CLINE_API_KEY: 'sk-cline' },
      nativeAuth: { auth: providersDocument('cline', clineAuth('cline-user-1', 1)) }
    }
  });
  const result = await fixture.probe.probe('acct_3e25a1db0334a63e7eef', 5_000);
  assert.equal(result.error, 'api_key_mode_not_applicable');
  assert.equal(fixture.requests.length, 0);
});

test('probe 在凭据缺失或非 cline 账号上直接失败，不发请求', async () => {
  const missing = createProbeFixture({ record: null });
  assert.equal((await missing.probe.probe('acct_x', 5_000)).error, 'credential_record_missing');
  const foreign = createProbeFixture({ record: { provider: 'codex', env: {}, nativeAuth: {} } });
  assert.equal((await foreign.probe.probe('acct_x', 5_000)).error, 'credential_record_missing');
  assert.equal(foreign.requests.length, 0);
});

test('probe 在套餐没有 Cline Pass entitlement 时报错，不产出快照', async () => {
  const fixture = createProbeFixture({
    responses: {
      'plan/usage-limits': { status: 200, body: limitsPayload() },
      'users/me/plan': { status: 200, body: { data: { userId: 'usr-test-1', plan: { displayName: 'Free' } } } }
    }
  });
  const result = await fixture.probe.probe('acct_3e25a1db0334a63e7eef', 5_000);
  assert.equal(result.error, 'cline_pass_entitlement_missing');
  assert.equal(result.snapshot, undefined);
});

test('probe 在一个窗口都算不出来时返回错误且不带快照（调用方保留旧缓存）', async () => {
  const fixture = createProbeFixture({
    responses: {
      'plan/usage-limits': { status: 200, body: limitsPayload([]) },
      'users/me/plan': { status: 200, body: planPayload() }
    }
  });
  const result = await fixture.probe.probe('acct_3e25a1db0334a63e7eef', 5_000);
  assert.match(result.error, /^cline_pass_windows_missing:5h,7days,30days$/);
  assert.equal(result.snapshot, undefined);
});

test('probe 在 401 时强制刷新一次 access token 并用新令牌重试', async () => {
  let calls = 0;
  const fixture = createProbeFixture({
    responses: {
      'plan/usage-limits': () => ({ status: 200, body: limitsPayload() }),
      'users/me/plan': () => {
        calls += 1;
        return calls === 1
          ? { status: 401, body: { error: 'unauthorized' } }
          : { status: 200, body: planPayload() };
      }
    }
  });
  const result = await fixture.probe.probe('acct_3e25a1db0334a63e7eef', 5_000);
  assert.equal(result.error, undefined);
  assert.equal(result.snapshot.entries.length, 3);
  assert.equal(fixture.refreshCalls.length, 1);
  assert.equal(fixture.refreshCalls[0][1].force, true);
});

test('服务端规范化保留 Cline Pass 快照（漏了这一支账号页会把额度丢成空）', () => {
  const { normalizeAccountUsageSnapshot } = require('../lib/server/account-usage-view');
  const { getMinRemainingPctFromUsageSnapshot } = require('../lib/account/usage-remaining');
  const view = normalizeAccountUsageSnapshot({
    kind: 'cline_pass_usage',
    source: 'cline_plan_usages_api',
    capturedAt: 1,
    account: { userId: 'usr-test-1', planName: 'Cline Pass (Monthly)', periodEndMs: 2 },
    entries: [
      { bucket: '5h', window: '5h', windowMinutes: 300, remainingPct: 75, totalUnits: 10, usedUnits: 2.5, remainingUnits: 7.5, unitType: 'usd', resetIn: '39m', resetAtMs: 3 },
      { bucket: '7days', window: '7days', windowMinutes: 10080, remainingPct: 79, totalUnits: 25, usedUnits: 5.25, remainingUnits: 19.75, unitType: 'usd', resetIn: '', resetAtMs: 0 }
    ]
  });
  assert.equal(view.kind, 'cline_pass_usage');
  assert.equal(view.entries.length, 2);
  assert.equal(view.entries[0].usedUnits, 2.5);
  assert.equal(view.account.planName, 'Cline Pass (Monthly)');
  // 账号级剩余取窗口最小值：5h 的 75%。
  assert.equal(getMinRemainingPctFromUsageSnapshot(view), 75);
});

test('probe 在刷新失败时把鉴权失败透出（auth: true），不伪装成「没有额度」', async () => {
  const fixture = createProbeFixture({
    refreshResult: { ok: false, refreshed: false, reason: 'refresh_http_400' },
    responses: {
      'plan/usage-limits': { status: 401, body: { error: 'unauthorized' } },
      'users/me/plan': { status: 401, body: { error: 'unauthorized' } }
    }
  });
  const result = await fixture.probe.probe('acct_3e25a1db0334a63e7eef', 5_000);
  assert.equal(result.error, 'cline_quota_http_401');
  assert.equal(result.auth, true);
  assert.equal(fixture.refreshCalls.length, 1);
});
