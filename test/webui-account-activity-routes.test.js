'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleAccountActivityRequest
} = require('../lib/server/webui-account-activity-routes');
const { createAccountActivityJobManager } = require('../lib/server/account-activity-job-manager');
const { resetRuns } = require('../lib/server/scheduled-run-guard');

// 运行守卫是进程内单例（防抖窗口跨请求保留），测试之间必须清空，否则前一个用例的
// 探测窗口会把后一个用例挡成 429。
test.beforeEach(() => resetRuns());

function createCtx({ method, pathname, url, body, deps, aiHomeDir = '/tmp/aih-activity-test' }) {
  const writes = [];
  return {
    method,
    pathname,
    // 真实网关传进来的 pathname 不含查询串，查询串只在 req.url 上。
    req: { url: url || pathname },
    res: {},
    aiHomeDir,
    deps,
    writes,
    readRequestBody: async () => Buffer.from(JSON.stringify(body || {}), 'utf8'),
    writeJson: (_res, status, payload) => writes.push({ status, payload })
  };
}

function baseDeps(overrides = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      fs: {},
      accountActivityJobManager: createAccountActivityJobManager(),
      listAccountCredentialRecords: () => [{ accountRef: 'acct_a' }, { accountRef: 'acct_b' }],
      runActivityClaim: async (input) => {
        calls.push(input);
        return { provider: input.provider, accountRef: input.record.accountRef, status: 'claimed' };
      },
      ...overrides
    }
  };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

test('批量领取：params 里选账号 → 只对该账号入队，参数透传到执行器', async () => {
  const { deps, calls } = baseDeps();
  const ctx = createCtx({
    method: 'POST',
    pathname: '/v0/webui/accounts/activity/run',
    body: {
      providers: ['zcode'],
      actionId: 'trial_plan',
      params: { accountRefs: ['acct_b'], planKind: 'weekend_build' }
    },
    deps
  });
  await handleAccountActivityRequest(ctx);
  assert.equal(ctx.writes[0].status, 202);
  const jobId = ctx.writes[0].payload.job.id;
  await waitFor(() => deps.accountActivityJobManager.getJob(jobId).status === 'succeeded');
  assert.deepEqual(calls.map((call) => call.record.accountRef), ['acct_b']);
  assert.deepEqual(calls[0].params, { accountRefs: ['acct_b'], planKind: 'weekend_build' });
});

test('批量领取：非法参数 400，不静默退化成「全量领取」', async () => {
  const { deps, calls } = baseDeps();
  const ctx = createCtx({
    method: 'POST',
    pathname: '/v0/webui/accounts/activity/run',
    body: { providers: ['zcode'], actionId: 'trial_plan', params: { planKind: 'nope' } },
    deps
  });
  await handleAccountActivityRequest(ctx);
  assert.equal(ctx.writes[0].status, 400);
  assert.equal(ctx.writes[0].payload.error, 'activity_params_invalid:activity_param_value_invalid:planKind');
  assert.equal(calls.length, 0);
});

test('参数候选值：账号来自凭据库端口，类型来自描述符声明', async () => {
  const { deps } = baseDeps();
  const ctx = createCtx({
    method: 'GET',
    pathname: '/v0/webui/accounts/activity/params',
    url: '/v0/webui/accounts/activity/params?provider=zcode&actionId=trial_plan',
    deps
  });
  await handleAccountActivityRequest(ctx);
  const payload = ctx.writes[0].payload;
  assert.equal(ctx.writes[0].status, 200);
  const accounts = payload.params.find((field) => field.key === 'accountRefs');
  assert.equal(accounts.source, 'accounts');
  assert.deepEqual(accounts.options.map((option) => option.value), ['acct_a', 'acct_b']);
  const kinds = payload.params.find((field) => field.key === 'planKind');
  assert.equal(kinds.source, 'declared');
  assert.deepEqual(kinds.options.map((option) => option.value), ['weekend_build', 'start_plan']);
});

test('探测：只读、不走任务队列，结果带类型目录', async () => {
  const { deps } = baseDeps({
    runActivityClaim: async (input) => ({
      provider: 'zcode',
      accountRef: input.record.accountRef,
      status: 'dry_run',
      plans: [{ planId: 'zcode-v3-start-plan-1030-wk', name: 'ZCODE WEEKEND BUILD' }]
    })
  });
  const ctx = createCtx({
    method: 'POST',
    pathname: '/v0/webui/accounts/activity/probe',
    body: { providers: ['zcode'], actionId: 'trial_plan' },
    deps
  });
  await handleAccountActivityRequest(ctx);
  const payload = ctx.writes[0].payload;
  assert.equal(ctx.writes[0].status, 200);
  assert.equal(payload.kinds.find((kind) => kind.id === 'weekend_build').claimable, true);
  // 探测不产生任务
  assert.equal(deps.accountActivityJobManager.listJobs().length, 0);
});

test('探测与领取分键空间：探测完立刻领取不会被自己的防抖挡住', async () => {
  const { deps } = baseDeps({
    runActivityClaim: async (input) => ({
      provider: 'zcode',
      accountRef: input.record.accountRef,
      status: input.dryRun ? 'dry_run' : 'claimed',
      ...(input.dryRun ? { plans: [] } : {})
    })
  });
  const probeCtx = createCtx({
    method: 'POST',
    pathname: '/v0/webui/accounts/activity/probe',
    body: { providers: ['zcode'], actionId: 'trial_plan' },
    deps
  });
  await handleAccountActivityRequest(probeCtx);
  assert.equal(probeCtx.writes[0].status, 200);

  const claimCtx = createCtx({
    method: 'POST',
    pathname: '/v0/webui/accounts/activity/run',
    body: { providers: ['zcode'], actionId: 'trial_plan' },
    deps
  });
  await handleAccountActivityRequest(claimCtx);
  assert.equal(claimCtx.writes[0].status, 202);
  const jobId = claimCtx.writes[0].payload.job.id;
  await waitFor(() => deps.accountActivityJobManager.getJob(jobId).status === 'succeeded');
});

test('探测正在跑时领取 409：只读也会打上游，并发就是自造 429', async () => {
  const { acquireRun } = require('../lib/server/scheduled-run-guard');
  const { activityProbeKey } = require('../lib/server/activity-run-keys');
  const { deps, calls } = baseDeps();
  const probeGuard = acquireRun(activityProbeKey('zcode', 'trial_plan'), { debounceMs: 0 });
  assert.equal(probeGuard.ok, true);
  try {
    const ctx = createCtx({
      method: 'POST',
      pathname: '/v0/webui/accounts/activity/run',
      body: { providers: ['zcode'], actionId: 'trial_plan' },
      deps
    });
    await handleAccountActivityRequest(ctx);
    assert.equal(ctx.writes[0].status, 409);
    assert.equal(ctx.writes[0].payload.error, 'activity_probe_running');
    assert.equal(calls.length, 0);
    assert.equal(deps.accountActivityJobManager.listJobs().length, 0);
  } finally {
    probeGuard.release();
  }
});

test('带参数指纹的领取在跑时探测也 409（不能只看裸键）', async () => {
  const { acquireRun, runKey } = require('../lib/server/scheduled-run-guard');
  const { activityClaimKey } = require('../lib/server/activity-run-keys');
  const { deps } = baseDeps();
  // 按参数领取的运行键带 #指纹；裸键检查会漏掉它，于是「边领边探」并发打上游。
  const claimGuard = acquireRun(
    runKey(activityClaimKey('zcode', 'trial_plan'), { accountRefs: ['acct_b'], planKind: 'weekend_build' }),
    { debounceMs: 0 }
  );
  assert.equal(claimGuard.ok, true);
  try {
    const ctx = createCtx({
      method: 'POST',
      pathname: '/v0/webui/accounts/activity/probe',
      body: { providers: ['zcode'], actionId: 'trial_plan' },
      deps
    });
    await handleAccountActivityRequest(ctx);
    assert.equal(ctx.writes[0].status, 409);
    assert.equal(ctx.writes[0].payload.error, 'activity_already_running');
  } finally {
    claimGuard.release();
  }
});
