'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  fetchKimiPlanStats,
  clearKimiPlanStatsCache,
  __private
} = require('../lib/server/kimi-plan-stats');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { writeDesktopSession } = require('../lib/server/kimi-desktop-session');

function makeJwt(expSeconds) {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `h.${payload}.s`;
}

function createFixture(t, { withSession = true } = {}) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kimi-plan-stats-'));
  t.after(() => {
    clearKimiPlanStatsCache();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'kimi',
    cliAccountId: '7',
    identitySeed: 'oauth:kimi:plan-stats@example.com'
  });
  if (withSession) {
    const written = writeDesktopSession(fs, aiHomeDir, accountRef, {
      accessToken: makeJwt(Math.floor(Date.now() / 1000) + 900),
      refreshToken: 'web-refresh-1',
      userId: 'u-plan'
    });
    assert.equal(written, true);
  }
  return { aiHomeDir, accountRef };
}

// 按调用队列返回响应，并记录 url/payload 供断言。
function createFetchQueue(responses) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    return { status: next.status, json: async () => next.data };
  };
  return { calls, fetchImpl };
}

// 2026-09-11 实测 GetSubscriptionStats 响应（Allegretto 账号，proto3 JSON 省略零值）。
const STATS_PAYLOAD = {
  ratelimitCode5h: { ratio: 0.3498, enabled: true, resetTime: '2026-09-11T06:24:30.734272845Z' },
  ratelimitCode7d: { ratio: 0.268, enabled: true, resetTime: '2026-09-13T15:24:30.734272845Z' },
  subscriptionBalance: {
    id: '1a00b2d5-59c2-832a-8000-0000c272e15c',
    feature: 'FEATURE_OMNI',
    type: 'SUBSCRIPTION',
    unit: 'UNIT_CREDIT',
    amountUsedRatio: 0.7813,
    kimiCodeUsedRatio: 0.3964,
    expireTime: '2026-09-16T00:00:00Z',
    domain: 'DOMAIN_NEXUS'
  },
  giftBalances: [
    {
      id: '19f6e758-9f92-8ba3-91d6-3d1338244fcc',
      type: 'GIFT',
      amountUsedRatio: 1,
      kimiCodeUsedRatio: 1,
      expireTime: '2026-12-31T15:59:59Z',
      displayName: 'Invite to Earn Credit'
    }
  ]
};

const SUBSCRIPTION_PAYLOAD = {
  subscription: {
    subscriptionId: '1a00b2ca-6d42-8b6b-8000-00000c1e4c6e',
    goods: {
      title: 'Allegretto',
      membershipLevel: 'LEVEL_INTERMEDIATE',
      billingCycle: { duration: 1, timeUnit: 'TIME_UNIT_MONTH' }
    },
    currentEndTime: '2026-09-16T00:00:00Z',
    nextBillingTime: '2026-09-15T15:24:30.808536Z',
    status: 'SUBSCRIPTION_STATUS_CANCEL',
    active: true
  },
  subscribed: true
};

test('normalizeSubscriptionStats 映射月度总量/5h/7d/Gift，proto3 零值缺席按 0 处理', () => {
  const stats = __private.normalizeSubscriptionStats(STATS_PAYLOAD, 1780000000000);
  assert.equal(stats.capturedAtMs, 1780000000000);
  assert.equal(stats.total.usedRatio, 0.7813);
  assert.equal(stats.total.codeUsedRatio, 0.3964);
  assert.equal(stats.total.resetAtMs, Date.parse('2026-09-16T00:00:00Z'));
  assert.equal(stats.rateLimits.code5h.usedRatio, 0.3498);
  assert.equal(stats.rateLimits.code5h.resetAtMs, Date.parse('2026-09-11T06:24:30.734272845Z'));
  assert.equal(stats.rateLimits.code7d.usedRatio, 0.268);
  // 聊天窗口未启用时整个对象缺席
  assert.equal(stats.rateLimits.chat5h, null);
  assert.equal(stats.rateLimits.chat7d, null);
  assert.equal(stats.gifts.length, 1);
  assert.equal(stats.gifts[0].name, 'Invite to Earn Credit');
  assert.equal(stats.gifts[0].usedRatio, 1);
  assert.equal(stats.gifts[0].expireAtMs, Date.parse('2026-12-31T15:59:59Z'));
  assert.equal(stats.notice, null);
  assert.equal(stats.overdrawn, false);
});

test('normalizeSubscriptionStats 处理月度用尽账号：ratio 缺席=0、notice 与 overdrawn 透传', () => {
  const payload = {
    ratelimitCode5h: { enabled: true, resetTime: '2026-09-11T11:02:32Z' },
    subscriptionBalance: {
      type: 'SUBSCRIPTION',
      amountUsedRatio: 1,
      kimiCodeUsedRatio: 0.4168,
      expireTime: '2026-09-14T00:00:00Z'
    },
    notice: {
      tip: 'Monthly quota used up',
      content: 'Your monthly quota is used up. Refreshes on {time}.',
      resetTime: '2026-09-14T00:00:00Z'
    },
    overdrawn: true
  };
  const stats = __private.normalizeSubscriptionStats(payload, 1780000000000);
  assert.equal(stats.rateLimits.code5h.usedRatio, 0);
  assert.equal(stats.rateLimits.code5h.enabled, true);
  assert.equal(stats.rateLimits.code7d, null);
  assert.equal(stats.total.usedRatio, 1);
  assert.equal(stats.overdrawn, true);
  assert.equal(stats.notice.tip, 'Monthly quota used up');
  assert.equal(stats.notice.resetAtMs, Date.parse('2026-09-14T00:00:00Z'));
});

test('normalizeSubscriptionStats 兼容 snake_case 字段名', () => {
  const stats = __private.normalizeSubscriptionStats({
    ratelimit_code_5h: { ratio: 0.5, reset_time: '2026-09-11T06:24:30Z' },
    subscription_balance: { amount_used_ratio: 0.25, kimi_code_used_ratio: 0.1, expire_time: '2026-09-16T00:00:00Z' },
    gift_balances: [{ display_name: 'Gift', amount_used_ratio: 0.75, expire_time: '2026-12-31T00:00:00Z' }]
  }, 1780000000000);
  assert.equal(stats.rateLimits.code5h.usedRatio, 0.5);
  assert.equal(stats.total.usedRatio, 0.25);
  assert.equal(stats.gifts[0].name, 'Gift');
});

test('normalizeSubscription 提取套餐名/等级/取消态/有效期', () => {
  const plan = __private.normalizeSubscription(SUBSCRIPTION_PAYLOAD);
  assert.equal(plan.name, 'Allegretto');
  assert.equal(plan.level, 'intermediate');
  assert.equal(plan.status, 'canceled');
  assert.equal(plan.validUntilMs, Date.parse('2026-09-15T15:24:30.808536Z'));
  assert.equal(plan.resetAtMs, Date.parse('2026-09-16T00:00:00Z'));
  assert.equal(__private.normalizeSubscription({}), null);
});

test('fetchKimiPlanStats 成功获取并合并 stats+subscription，二次调用命中缓存', async (t) => {
  const { aiHomeDir, accountRef } = createFixture(t);
  const { calls, fetchImpl } = createFetchQueue([
    { status: 200, data: STATS_PAYLOAD },
    { status: 200, data: SUBSCRIPTION_PAYLOAD }
  ]);
  const result = await fetchKimiPlanStats({ fs, aiHomeDir, accountRef, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.stats.plan.name, 'Allegretto');
  assert.equal(result.stats.total.usedRatio, 0.7813);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/apiv2\/kimi\.gateway\.membership\.v2\.MembershipService\/GetSubscriptionStats$/);
  assert.match(calls[1].url, /\/GetSubscription$/);
  assert.equal(calls[0].options.headers.Authorization.startsWith('Bearer '), true);

  const cached = await fetchKimiPlanStats({ fs, aiHomeDir, accountRef, fetchImpl });
  assert.equal(cached.ok, true);
  assert.equal(cached.cached, true);
  assert.equal(calls.length, 2);

  const refreshed = await fetchKimiPlanStats({ fs, aiHomeDir, accountRef, fetchImpl }, { refresh: true });
  assert.equal(refreshed.ok, true);
  assert.equal(calls.length, 4);
});

test('fetchKimiPlanStats 在未托管桌面 session 时返回 desktop_session_missing', async (t) => {
  const { aiHomeDir, accountRef } = createFixture(t, { withSession: false });
  const { calls, fetchImpl } = createFetchQueue([{ status: 200, data: {} }]);
  const result = await fetchKimiPlanStats({ fs, aiHomeDir, accountRef, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'desktop_session_missing');
  assert.equal(calls.length, 0);
});

test('fetchKimiPlanStats 在 401 时轮换 web token 并重试一次', async (t) => {
  const { aiHomeDir, accountRef } = createFixture(t);
  const { calls, fetchImpl } = createFetchQueue([
    { status: 401, data: {} },
    { status: 200, data: { access_token: makeJwt(Math.floor(Date.now() / 1000) + 900), refresh_token: 'web-refresh-2' } },
    { status: 200, data: STATS_PAYLOAD },
    { status: 200, data: SUBSCRIPTION_PAYLOAD }
  ]);
  const result = await fetchKimiPlanStats({ fs, aiHomeDir, accountRef, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 4);
  assert.match(calls[1].url, /auth\.kimi\.com\/api\/account\.gateway\.v1\.AuthService\/RefreshToken$/);
  assert.match(calls[2].url, /GetSubscriptionStats$/);
});

test('fetchKimiPlanStats 在 GetSubscription 失败时仍返回 stats（plan=null）', async (t) => {
  const { aiHomeDir, accountRef } = createFixture(t);
  const { fetchImpl } = createFetchQueue([
    { status: 200, data: STATS_PAYLOAD },
    { status: 500, data: {} }
  ]);
  const result = await fetchKimiPlanStats({ fs, aiHomeDir, accountRef, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.stats.plan, null);
  assert.equal(result.stats.gifts.length, 1);
});

test('fetchKimiPlanStats 在上游非 200 时返回 http 错误且不写缓存', async (t) => {
  const { aiHomeDir, accountRef } = createFixture(t);
  const { fetchImpl } = createFetchQueue([{ status: 502, data: {} }]);
  const result = await fetchKimiPlanStats({ fs, aiHomeDir, accountRef, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'kimi_plan_stats_http_502');
});
