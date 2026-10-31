'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { probeActivityAction } = require('../lib/account/activity-claim');

function targetsOf(...refs) {
  return refs.map((accountRef) => ({ provider: 'zcode', record: { accountRef } }));
}

test('探测：逐账号只读执行，跨账号按 plan 聚合，类型目录带 claimable', async () => {
  const seen = [];
  const result = await probeActivityAction({
    provider: 'zcode',
    actionId: 'trial_plan',
    targets: targetsOf('a', 'b', 'c'),
    runActivityClaim: async (input) => {
      seen.push({ accountRef: input.record.accountRef, dryRun: input.dryRun });
      if (input.record.accountRef === 'c') {
        return { provider: 'zcode', accountRef: 'c', status: 'error', error: 'zcode_jwt_missing' };
      }
      return {
        provider: 'zcode',
        accountRef: input.record.accountRef,
        status: 'dry_run',
        discovery: 'marketing_touch',
        plans: [{ planId: 'zcode-v3-start-plan-1030-wk', name: 'ZCODE WEEKEND BUILD' }]
      };
    }
  });

  // 只读：dryRun 一定是 true，且逐账号串行
  assert.deepEqual(seen, [
    { accountRef: 'a', dryRun: true },
    { accountRef: 'b', dryRun: true },
    { accountRef: 'c', dryRun: true }
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.plans.length, 1);
  assert.deepEqual(result.plans[0].accounts, ['a', 'b']);
  assert.equal(result.plans[0].planKind, '');
  // 类型目录来自描述符声明，claimable 由本次探测决定
  const weekend = result.kinds.find((kind) => kind.id === 'weekend_build');
  assert.equal(weekend.claimable, true);
  const startPlan = result.kinds.find((kind) => kind.id === 'start_plan');
  assert.equal(startPlan.claimable, false);
  // 失败也被如实统计（探测失败不影响其他账号）
  assert.equal(result.summary.failed, 1);
  assert.equal(result.failures.byCode[0].code, 'zcode_jwt_missing');
});

test('探测：不支持探测的动作明确拒绝，而不是偷偷执行一次领取', async () => {
  const result = await probeActivityAction({
    provider: 'qoder',
    actionId: 'daily_checkin',
    targets: targetsOf('a')
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'activity_probe_unsupported');
});

test('探测：没有账号时返回空目录而不是报错', async () => {
  const result = await probeActivityAction({ provider: 'zcode', actionId: 'trial_plan', targets: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.accounts, []);
  assert.deepEqual(result.plans, []);
});
