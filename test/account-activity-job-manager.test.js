'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAccountActivityJobManager } = require('../lib/server/account-activity-job-manager');

function waitForTerminal(manager, jobId, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      const job = manager.getJob(jobId);
      if (job && ['succeeded', 'partial', 'failed'].includes(job.status)) {
        resolve(job);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`job ${jobId} 未在 ${timeoutMs}ms 内进入终态`));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

function targetsOf(...refs) {
  return refs.map((accountRef) => ({ provider: 'zcode', record: { accountRef } }));
}

test('后台任务汇总：成功与失败混跑时给出 partial 与按错误码的明细', async () => {
  const manager = createAccountActivityJobManager();
  const started = manager.start({
    providers: ['zcode'],
    actionId: 'trial_plan',
    targets: targetsOf('a', 'b', 'c'),
    execute: async ({ record }) => (record.accountRef === 'c'
      ? { provider: 'zcode', accountRef: 'c', status: 'error', error: 'zcode_captcha_rejected' }
      : { provider: 'zcode', accountRef: record.accountRef, status: 'claimed' })
  });
  assert.equal(started.ok, true);
  const job = await waitForTerminal(manager, started.job.id);

  assert.equal(job.status, 'partial');
  assert.equal(job.summary.claimed, 2);
  assert.equal(job.summary.failed, 1);
  assert.equal(job.summary.succeeded, 2);
  assert.equal(job.failures.total, 1);
  assert.equal(job.failures.byCode[0].code, 'zcode_captcha_rejected');
  assert.equal(job.failures.byAccount[0].accountRef, 'c');
  assert.equal(job.errorCode, 'zcode_captcha_rejected');
  // 每个结果自带归一后的错误码，页面不用再解析 error 字符串
  assert.equal(job.results.find((row) => row.accountRef === 'c').errorCode, 'zcode_captcha_rejected');
});

test('全部失败：error 仍是 all_accounts_failed，但旁边有众数错误码与人话摘要', async () => {
  const manager = createAccountActivityJobManager();
  const started = manager.start({
    providers: ['zcode'],
    actionId: 'trial_plan',
    targets: targetsOf('a', 'b'),
    execute: async ({ record }) => ({
      provider: 'zcode',
      accountRef: record.accountRef,
      status: 'error',
      error: 'zcode_jwt_missing'
    })
  });
  const job = await waitForTerminal(manager, started.job.id);

  assert.equal(job.status, 'failed');
  assert.equal(job.error, 'all_accounts_failed');
  assert.equal(job.errorCode, 'zcode_jwt_missing');
  assert.equal(job.errorSummary, '全部 2 个账号失败：zcode_jwt_missing ×2');
});

test('「暂无可领」不是失败：全部 nothing_claimable 时任务算成功', async () => {
  const manager = createAccountActivityJobManager();
  const started = manager.start({
    providers: ['zcode'],
    actionId: 'trial_plan',
    targets: targetsOf('a', 'b'),
    execute: async ({ record }) => ({
      provider: 'zcode',
      accountRef: record.accountRef,
      status: 'nothing_claimable'
    })
  });
  const job = await waitForTerminal(manager, started.job.id);

  assert.equal(job.status, 'succeeded');
  assert.equal(job.summary.nothingClaimable, 2);
  assert.equal(job.summary.failed, 0);
  assert.equal(job.error, '');
});
