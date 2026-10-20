'use strict';

// WebUI 账号活动路由。
//
// 守住三条边界：
//   * 批量领取是异步任务：POST 只返回 job，执行在后台，页面轮询 GET jobs/:id；
//   * 批量选择必须显式给出 providers + actionId，且每个 provider 都必须声明该动作；
//     绝不回退成“所有 provider 一起跑”（Qoder / ZCode 不能混批）；
//   * 业务失败是 200 + ok:false（活动未开放 / 已领过都是正常结果），只有路径 / 选择 /
//     账号不存在才是 4xx。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleAccountActivityRequest,
  matchAccountActivityRoute
} = require('../lib/server/webui-account-activity-routes');
const { createAccountActivityJobManager } = require('../lib/server/account-activity-job-manager');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createCtx(pathname, overrides = {}) {
  const calls = [];
  const recordsByProvider = overrides.recordsByProvider || {
    qoder: [
      { provider: 'qoder', accountRef: 'acct_qoder_1' },
      { provider: 'qoder', accountRef: 'acct_qoder_2' }
    ],
    zcode: [{ provider: 'zcode', accountRef: 'acct_zcode_1' }]
  };
  const ctx = {
    method: overrides.method || 'POST',
    pathname,
    aiHomeDir: '/tmp/aih-home',
    fs: {},
    processObj: process,
    res: {},
    deps: {
      listAccountCredentialRecords: (_fs, _home, provider) => recordsByProvider[provider] || [],
      listActivityActions: (provider) => {
        if (provider === 'qoder') return [{ id: 'daily_checkin', label: '签到' }];
        if (provider === 'zcode') return [{ id: 'trial_plan', label: '领臭鸡蛋' }];
        return [];
      },
      runActivityClaim: async (input) => ({
        provider: input.provider,
        accountRef: input.record.accountRef,
        actionId: input.actionId,
        status: 'claimed',
        credits: 100
      }),
      ...overrides.deps
    },
    writeJson: (_res, status, payload) => calls.push({ status, payload })
  };
  return { ctx, calls };
}

function attachBody(ctx, body) {
  ctx.req = {};
  ctx.readRequestBody = async () => Buffer.from(JSON.stringify(body));
}

test('matchAccountActivityRoute 解析批量、任务查询与单账号动作', () => {
  assert.deepEqual(
    matchAccountActivityRoute('POST', '/v0/webui/accounts/activity/run'),
    { bulk: true }
  );
  assert.deepEqual(
    matchAccountActivityRoute('GET', '/v0/webui/accounts/activity/jobs/activity-job-abc'),
    { jobId: 'activity-job-abc' }
  );
  assert.deepEqual(
    matchAccountActivityRoute('POST', '/v0/webui/accounts/qoder/acct_1/activity/daily_checkin'),
    { bulk: false, provider: 'qoder', accountRef: 'acct_1', actionId: 'daily_checkin' }
  );
  assert.equal(matchAccountActivityRoute('GET', '/v0/webui/accounts/activity/run'), null);
  assert.equal(matchAccountActivityRoute('POST', '/v0/webui/accounts/qoder/acct_1/activity'), null);
});

test('批量领取只接受显式的 providers + actionId，不再回退到全部 provider', async () => {
  const missingBody = createCtx('/v0/webui/accounts/activity/run');
  await handleAccountActivityRequest(missingBody.ctx);
  assert.equal(missingBody.calls[0].status, 400);
  assert.equal(missingBody.calls[0].payload.error, 'invalid_activity_selection');

  const missingAction = createCtx('/v0/webui/accounts/activity/run');
  attachBody(missingAction.ctx, { providers: ['qoder'] });
  await handleAccountActivityRequest(missingAction.ctx);
  assert.equal(missingAction.calls[0].status, 400);
  assert.equal(missingAction.calls[0].payload.error, 'invalid_activity_selection');
});

test('批量领取拒绝混入未声明该动作的 provider（Qoder 任务不会带上 ZCode）', async () => {
  const { ctx, calls } = createCtx('/v0/webui/accounts/activity/run', {
    deps: {
      accountActivityJobManager: {
        start: () => { throw new Error('should not start'); },
        getJob: () => null
      }
    }
  });
  attachBody(ctx, { providers: ['qoder', 'zcode'], actionId: 'daily_checkin' });
  await handleAccountActivityRequest(ctx);
  assert.equal(calls[0].status, 400);
  assert.equal(calls[0].payload.error, 'activity_action_unknown:zcode:daily_checkin');
});

test('批量领取按当前供应商快照账号并返回 202 job', async () => {
  const started = [];
  const { ctx, calls } = createCtx('/v0/webui/accounts/activity/run', {
    deps: {
      accountActivityJobManager: {
        start: (input) => {
          started.push(input);
          return {
            ok: true,
            alreadyRunning: false,
            job: {
              id: 'activity-job-1',
              providers: input.providers,
              actionId: input.actionId,
              actionLabel: input.actionLabel,
              status: 'queued',
              progress: { total: input.targets.length, completed: 0 }
            }
          };
        },
        getJob: () => null
      }
    }
  });
  attachBody(ctx, { providers: ['qoder'], actionId: 'daily_checkin' });
  await handleAccountActivityRequest(ctx);
  assert.equal(calls[0].status, 202);
  assert.equal(calls[0].payload.ok, true);
  assert.equal(calls[0].payload.job.id, 'activity-job-1');
  assert.equal(started.length, 1);
  assert.deepEqual(started[0].providers, ['qoder']);
  assert.equal(started[0].actionId, 'daily_checkin');
  assert.equal(started[0].actionLabel, '签到');
  assert.deepEqual(
    started[0].targets.map((target) => target.record.accountRef),
    ['acct_qoder_1', 'acct_qoder_2']
  );
  assert.deepEqual(started[0].targets.map((target) => target.provider), ['qoder', 'qoder']);
  assert.equal(typeof started[0].execute, 'function');
});

test('批量领取没有可执行账号时明确失败', async () => {
  const { ctx, calls } = createCtx('/v0/webui/accounts/activity/run', {
    recordsByProvider: { qoder: [], zcode: [] },
    deps: {
      accountActivityJobManager: {
        start: () => { throw new Error('should not start'); },
        getJob: () => null
      }
    }
  });
  attachBody(ctx, { providers: ['qoder'], actionId: 'daily_checkin' });
  await handleAccountActivityRequest(ctx);
  assert.equal(calls[0].status, 400);
  assert.equal(calls[0].payload.error, 'activity_no_accounts');
});

test('任务查询返回 job，未知任务 404', async () => {
  const job = {
    id: 'activity-job-1',
    status: 'running',
    progress: { total: 2, completed: 1 },
    results: []
  };
  const { ctx, calls } = createCtx('/v0/webui/accounts/activity/jobs/activity-job-1', {
    method: 'GET',
    deps: {
      accountActivityJobManager: {
        start: () => { throw new Error('should not start'); },
        getJob: (jobId) => (jobId === 'activity-job-1' ? job : null)
      }
    }
  });
  await handleAccountActivityRequest(ctx);
  assert.equal(calls[0].status, 200);
  assert.equal(calls[0].payload.job.id, 'activity-job-1');
  const found = createCtx('/v0/webui/accounts/activity/jobs/missing', {
    method: 'GET',
    deps: {
      accountActivityJobManager: {
        start: () => { throw new Error('should not start'); },
        getJob: () => null
      }
    }
  });
  await handleAccountActivityRequest(found.ctx);
  assert.equal(found.calls[0].status, 404);
  assert.equal(found.calls[0].payload.error, 'activity_job_not_found');
});

test('批量任务真实接线：POST 立即返回 job，GET 轮询到最终结果', async () => {
  const manager = createAccountActivityJobManager();
  const { ctx, calls } = createCtx('/v0/webui/accounts/activity/run', {
    deps: {
      accountActivityJobManager: manager,
      runActivityClaim: async (input) => {
        await sleep(5);
        return {
          provider: input.provider,
          accountRef: input.record.accountRef,
          actionId: input.actionId,
          status: 'claimed'
        };
      }
    }
  });
  attachBody(ctx, { providers: ['qoder'], actionId: 'daily_checkin' });
  await handleAccountActivityRequest(ctx);
  assert.equal(calls[0].status, 202);
  assert.equal(calls[0].payload.ok, true);
  assert.equal(calls[0].payload.job.status, 'queued');
  const jobId = calls[0].payload.job.id;

  let job = null;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    job = manager.getJob(jobId);
    if (job && job.status === 'succeeded') break;
    await sleep(5);
  }
  assert.equal(job.status, 'succeeded');
  assert.equal(job.summary.claimed, 2);

  const poll = createCtx(`/v0/webui/accounts/activity/jobs/${jobId}`, {
    method: 'GET',
    deps: { accountActivityJobManager: manager }
  });
  await handleAccountActivityRequest(poll.ctx);
  assert.equal(poll.calls[0].status, 200);
  assert.equal(poll.calls[0].payload.job.id, jobId);
  assert.equal(poll.calls[0].payload.job.progress.completed, 2);
  assert.equal(poll.calls[0].payload.job.results.length, 2);
});

test('单账号动作：未知 provider / 未知动作 / 账号不存在分别明确失败', async () => {
  const unsupported = createCtx('/v0/webui/accounts/codex/acct_1/activity/daily_checkin');
  await handleAccountActivityRequest(unsupported.ctx);
  assert.equal(unsupported.calls[0].status, 400);
  assert.equal(unsupported.calls[0].payload.error, 'activity_unsupported:codex');

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

test('单账号业务失败仍返回 200（不是服务器故障）', async () => {
  const { ctx, calls } = createCtx('/v0/webui/accounts/qoder/acct_qoder_1/activity/daily_checkin', {
    deps: {
      runActivityClaim: async (input) => ({
        provider: input.provider,
        accountRef: input.record.accountRef,
        status: 'error',
        error: 'qoder_token_missing'
      })
    }
  });
  await handleAccountActivityRequest(ctx);
  assert.equal(calls[0].status, 200);
  assert.equal(calls[0].payload.ok, false);
  assert.equal(calls[0].payload.error, 'qoder_token_missing');
});

test('非活动路径不接管（交给后续路由）', async () => {
  const { ctx, calls } = createCtx('/v0/webui/accounts/qoder/acct_1/refresh');
  assert.equal(await handleAccountActivityRequest(ctx), false);
  assert.equal(calls.length, 0);
});
