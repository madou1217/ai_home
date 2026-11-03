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

test('参数指纹：同动作不同参数是不同任务，互不复用；无参数仍是历史键', async () => {
  const { targetKeyOf } = require('../lib/server/account-activity-job-manager');
  assert.equal(targetKeyOf('trial_plan', ['zcode'], {}), 'trial_plan:zcode');
  assert.notEqual(
    targetKeyOf('trial_plan', ['zcode'], { accountRefs: ['a'] }),
    targetKeyOf('trial_plan', ['zcode'], { accountRefs: ['b'] })
  );

  const manager = createAccountActivityJobManager();
  const make = (accountRef, params) => manager.start({
    providers: ['zcode'],
    actionId: 'trial_plan',
    params,
    targets: targetsOf(accountRef),
    execute: async () => new Promise((resolve) => {
      setTimeout(() => resolve({ provider: 'zcode', accountRef, status: 'claimed' }), 5);
    })
  });
  const first = make('a', { accountRefs: ['a'] });
  const second = make('b', { accountRefs: ['b'] });
  // 两个任务并行存在（全局串行执行，但不会被 findActive 合并）
  assert.equal(first.job.id === second.job.id, false);
  assert.deepEqual(first.job.params, { accountRefs: ['a'] });
  await waitForTerminal(manager, first.job.id);
  await waitForTerminal(manager, second.job.id);
});
