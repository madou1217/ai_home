'use strict';

// WebUI 账号活动路由（POST /v0/webui/accounts/activity/run 与单账号动作）。
//
// 守住两条边界：
//   * 执行走 CLI 同一条策略执行器（注入点唯一），路由不自己拼上游请求；
//   * 业务失败是 200 + ok:false（活动未开放 / 已领过都是正常结果），只有路径/账号/动作
//     不存在才是 4xx。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleAccountActivityRequest,
  matchAccountActivityRoute
} = require('../lib/server/webui-account-activity-routes');

function createCtx(pathname, overrides = {}) {
  const calls = [];
  const records = overrides.records || [
    { provider: 'qoder', accountRef: 'acct_qoder_1' },
    { provider: 'qoder', accountRef: 'acct_qoder_2' }
  ];
  const ctx = {
    method: overrides.method || 'POST',
    pathname,
    aiHomeDir: '/tmp/aih-home',
    fs: {},
    processObj: process,
    res: {},
    deps: {
      listAccountCredentialRecords: () => records,
      listActivityProviders: () => ['qoder'],
      listActivityActions: (provider) => (provider === 'qoder'
        ? [{ id: 'daily_checkin', label: '每日签到' }]
        : []),
      runActivityClaim: async (input) => ({
        provider: input.provider,
        accountRef: input.record.accountRef,
        actionId: input.actionId || 'daily_checkin',
        status: 'claimed',
        credits: 100
      }),
      ...overrides.deps
    },
    writeJson: (_res, status, payload) => calls.push({ status, payload })
  };
  return { ctx, calls };
}

test('matchAccountActivityRoute 只认 POST，并解析单账号动作', () => {
  assert.deepEqual(
    matchAccountActivityRoute('POST', '/v0/webui/accounts/activity/run'),
    { bulk: true }
  );
  assert.deepEqual(
    matchAccountActivityRoute('POST', '/v0/webui/accounts/qoder/acct_1/activity/daily_checkin'),
    { bulk: false, provider: 'qoder', accountRef: 'acct_1', actionId: 'daily_checkin' }
  );
  assert.equal(matchAccountActivityRoute('GET', '/v0/webui/accounts/activity/run'), null);
  assert.equal(matchAccountActivityRoute('POST', '/v0/webui/accounts/qoder/acct_1/activity'), null);
});

test('批量领取逐账号执行并汇总（账号来源由注入的仓库读取器决定）', async () => {
  const { ctx, calls } = createCtx('/v0/webui/accounts/activity/run');
  assert.equal(await handleAccountActivityRequest(ctx), true);
  assert.equal(calls.length, 1);
  const { status, payload } = calls[0];
  assert.equal(status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.results.length, 2);
  assert.deepEqual(payload.summary, {
    accounts: 2,
    claimed: 2,
    alreadyClaimed: 0,
    nothingClaimable: 0,
    notApplicable: 0,
    failed: 0
  });
});

test('批量领取按 providers + actionId 收窄到供应商 tab，未声明该动作的站点跳过', async () => {
  const seen = [];
  const recordsByProvider = {
    qoder: [{ provider: 'qoder', accountRef: 'acct_qoder_1' }],
    zcode: [{ provider: 'zcode', accountRef: 'acct_zcode_1' }]
  };
  const { ctx, calls } = createCtx('/v0/webui/accounts/activity/run', {
    deps: {
      listActivityProviders: () => ['qoder', 'zcode'],
      listActivityActions: (provider) => (provider === 'qoder'
        ? [{ id: 'daily_checkin', label: '签到' }]
        : [{ id: 'trial_plan', label: '领臭鸡蛋' }]),
      listAccountCredentialRecords: (_fs, _home, provider) => recordsByProvider[provider] || [],
      runActivityClaim: async (input) => {
        seen.push({ provider: input.provider, actionId: input.actionId });
        return {
          provider: input.provider,
          accountRef: input.record.accountRef,
          actionId: input.actionId,
          status: 'claimed'
        };
      }
    }
  });
  ctx.req = {};
  ctx.readRequestBody = async () => Buffer.from(JSON.stringify({
    providers: ['qoder', 'zcode'],
    actionId: 'daily_checkin'
  }));
  assert.equal(await handleAccountActivityRequest(ctx), true);
  assert.deepEqual(seen, [{ provider: 'qoder', actionId: 'daily_checkin' }]);
  assert.equal(calls[0].status, 200);
  assert.equal(calls[0].payload.summary.accounts, 1);
});

test('批量领取筛选后没有任何可用 provider 时明确失败', async () => {
  const { ctx, calls } = createCtx('/v0/webui/accounts/activity/run');
  ctx.req = {};
  ctx.readRequestBody = async () => Buffer.from(JSON.stringify({ providers: ['claude'] }));
  await handleAccountActivityRequest(ctx);
  assert.equal(calls[0].status, 400);
  assert.equal(calls[0].payload.error, 'activity_unsupported');
});

test('批量领取把业务失败计入 failed，但仍返回 200（不是服务器故障）', async () => {
  const { ctx, calls } = createCtx('/v0/webui/accounts/activity/run', {
    deps: {
      runActivityClaim: async (input) => ({
        provider: input.provider,
        accountRef: input.record.accountRef,
        status: input.record.accountRef === 'acct_qoder_2' ? 'error' : 'already_claimed',
        error: input.record.accountRef === 'acct_qoder_2' ? 'qoder_token_missing' : undefined
      })
    }
  });
  await handleAccountActivityRequest(ctx);
  assert.equal(calls[0].status, 200);
  assert.equal(calls[0].payload.ok, false);
  assert.equal(calls[0].payload.summary.failed, 1);
  assert.equal(calls[0].payload.summary.alreadyClaimed, 1);
});

test('单账号动作：未知 provider / 未知动作 / 账号不存在分别明确失败', async () => {
  const unsupported = createCtx('/v0/webui/accounts/zcode/acct_1/activity/daily_checkin');
  await handleAccountActivityRequest(unsupported.ctx);
  assert.equal(unsupported.calls[0].status, 400);
  assert.equal(unsupported.calls[0].payload.error, 'activity_unsupported:zcode');

  const unknownAction = createCtx('/v0/webui/accounts/qoder/acct_1/activity/nope');
  await handleAccountActivityRequest(unknownAction.ctx);
  assert.equal(unknownAction.calls[0].status, 404);
  assert.equal(unknownAction.calls[0].payload.error, 'activity_action_unknown:nope');

  const missing = createCtx('/v0/webui/accounts/qoder/acct_missing/activity/daily_checkin');
  await handleAccountActivityRequest(missing.ctx);
  assert.equal(missing.calls[0].status, 404);
  assert.equal(missing.calls[0].payload.error, 'account_not_found');
});

test('单账号动作把选中的 actionId 透传给执行器', async () => {
  let seen = null;
  const { ctx, calls } = createCtx('/v0/webui/accounts/qoder/acct_qoder_1/activity/daily_checkin', {
    deps: {
      runActivityClaim: async (input) => {
        seen = input;
        return { provider: input.provider, accountRef: input.record.accountRef, status: 'claimed' };
      }
    }
  });
  await handleAccountActivityRequest(ctx);
  assert.equal(seen.actionId, 'daily_checkin');
  assert.equal(seen.provider, 'qoder');
  assert.equal(calls[0].status, 200);
  assert.equal(calls[0].payload.ok, true);
});

test('非活动路径不接管（交给后续路由）', async () => {
  const { ctx, calls } = createCtx('/v0/webui/accounts/qoder/acct_1/refresh');
  assert.equal(await handleAccountActivityRequest(ctx), false);
  assert.equal(calls.length, 0);
});
