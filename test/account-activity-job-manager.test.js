'use strict';

// 账号活动异步任务执行器：
//   * POST 返回 queued job，后台串行执行；
//   * 进度、结果、汇总可在任务结束后查询；
//   * 同一 (actionId + providers) 正在跑时复用任务，避免连点重复领取；
//   * execute 抛异常时转成单账号 error 结果，不炸掉整个队列。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAccountActivityJobManager,
  isTerminalStatus
} = require('../lib/server/account-activity-job-manager');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForJob(manager, jobId, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = manager.getJob(jobId);
    if (job && predicate(job)) return job;
    await sleep(5);
  }
  throw new Error(`job ${jobId} did not reach expected state`);
}

function target(accountRef, provider = 'qoder') {
  return { provider, record: { provider, accountRef } };
}

test('后台任务串行执行账号并汇报进度与汇总', async () => {
  const manager = createAccountActivityJobManager();
  const seen = [];
  const started = manager.start({
    providers: ['qoder'],
    actionId: 'daily_checkin',
    actionLabel: '签到',
    targets: [target('a1'), target('a2')],
    execute: async ({ record }) => {
      seen.push(record.accountRef);
      return { provider: 'qoder', accountRef: record.accountRef, status: 'claimed', credits: 100 };
    }
  });
  assert.equal(started.ok, true);
  assert.equal(started.job.status, 'queued');
  assert.equal(started.job.progress.total, 2);

  const job = await waitForJob(manager, started.job.id, (entry) => isTerminalStatus(entry.status));
  assert.deepEqual(seen, ['a1', 'a2']);
  assert.equal(job.status, 'succeeded');
  assert.equal(job.progress.completed, 2);
  assert.equal(job.progress.percent, 100);
  assert.equal(job.results.length, 2);
  assert.deepEqual(job.summary, {
    accounts: 2,
    claimed: 2,
    alreadyClaimed: 0,
    nothingClaimable: 0,
    notApplicable: 0,
    failed: 0
  });
});

test('单账号失败记为 partial，execute 抛异常也变成结构化结果', async () => {
  const manager = createAccountActivityJobManager();
  const started = manager.start({
    providers: ['zcode'],
    actionId: 'trial_plan',
    actionLabel: '领臭鸡蛋',
    targets: [target('z1', 'zcode'), target('z2', 'zcode')],
    execute: async ({ record }) => {
      if (record.accountRef === 'z2') throw new Error('captcha_timeout');
      return { provider: 'zcode', accountRef: record.accountRef, status: 'nothing_claimable' };
    }
  });
  const job = await waitForJob(manager, started.job.id, (entry) => isTerminalStatus(entry.status));
  assert.equal(job.status, 'partial');
  assert.equal(job.summary.nothingClaimable, 1);
  assert.equal(job.summary.failed, 1);
  assert.equal(job.results[1].status, 'error');
  assert.match(job.results[1].error, /captcha_timeout/);
});

test('全部账号失败时任务状态为 failed', async () => {
  const manager = createAccountActivityJobManager();
  const started = manager.start({
    providers: ['qoder'],
    actionId: 'daily_checkin',
    targets: [target('a1')],
    execute: async () => ({
      provider: 'qoder',
      accountRef: 'a1',
      status: 'error',
      error: 'qoder_token_missing'
    })
  });
  const job = await waitForJob(manager, started.job.id, (entry) => isTerminalStatus(entry.status));
  assert.equal(job.status, 'failed');
  assert.equal(job.error, 'all_accounts_failed');
  assert.equal(job.summary.failed, 1);
});

test('同一动作与 provider 集合正在跑时复用现有任务', async () => {
  const manager = createAccountActivityJobManager();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = manager.start({
    providers: ['qoder', 'qodercn'],
    actionId: 'daily_checkin',
    targets: [target('a1')],
    execute: async () => {
      await gate;
      return { provider: 'qoder', accountRef: 'a1', status: 'claimed' };
    }
  });
  const second = manager.start({
    providers: ['qodercn', 'qoder'],
    actionId: 'daily_checkin',
    targets: [target('a2')],
    execute: async () => ({ provider: 'qodercn', accountRef: 'a2', status: 'claimed' })
  });
  assert.equal(second.ok, true);
  assert.equal(second.alreadyRunning, true);
  assert.equal(second.job.id, first.job.id);
  release();
  await waitForJob(manager, first.job.id, (entry) => isTerminalStatus(entry.status));

  // 终态后再次开始应创建新任务（已领过可以重试，新的任务会得到 already_claimed）。
  const third = manager.start({
    providers: ['qoder', 'qodercn'],
    actionId: 'daily_checkin',
    targets: [target('a1')],
    execute: async () => ({ provider: 'qoder', accountRef: 'a1', status: 'already_claimed' })
  });
  assert.equal(third.alreadyRunning, false);
  assert.notEqual(third.job.id, first.job.id);
  await waitForJob(manager, third.job.id, (entry) => isTerminalStatus(entry.status));
});

test('不同动作的任务全局串行，后一个在队列里保持 queued', async () => {
  const manager = createAccountActivityJobManager();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = manager.start({
    providers: ['qoder'],
    actionId: 'daily_checkin',
    targets: [target('a1')],
    execute: async () => {
      await gate;
      return { provider: 'qoder', accountRef: 'a1', status: 'claimed' };
    }
  });
  const second = manager.start({
    providers: ['zcode'],
    actionId: 'trial_plan',
    targets: [target('z1', 'zcode')],
    execute: async () => ({ provider: 'zcode', accountRef: 'z1', status: 'nothing_claimable' })
  });
  await sleep(10);
  assert.equal(manager.getJob(first.job.id).status, 'running');
  assert.equal(manager.getJob(second.job.id).status, 'queued');
  release();
  await waitForJob(manager, first.job.id, (entry) => isTerminalStatus(entry.status));
  const finishedSecond = await waitForJob(
    manager,
    second.job.id,
    (entry) => isTerminalStatus(entry.status)
  );
  assert.equal(finishedSecond.status, 'succeeded');
  assert.equal(finishedSecond.summary.nothingClaimable, 1);
});

test('序列化结果不暴露 execute / targets 等内部闭包', async () => {
  const manager = createAccountActivityJobManager();
  const started = manager.start({
    providers: ['qoder'],
    actionId: 'daily_checkin',
    targets: [target('a1')],
    execute: async () => ({ provider: 'qoder', accountRef: 'a1', status: 'claimed' })
  });
  await waitForJob(manager, started.job.id, (entry) => isTerminalStatus(entry.status));
  const job = manager.getJob(started.job.id);
  assert.equal(Object.prototype.hasOwnProperty.call(job, 'execute'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(job, 'targets'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(job, 'targetKey'), false);
});

test('空选择不创建任务', () => {
  const manager = createAccountActivityJobManager();
  const result = manager.start({
    providers: [],
    actionId: '',
    targets: [],
    execute: async () => ({})
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'activity_selection_empty');
});
