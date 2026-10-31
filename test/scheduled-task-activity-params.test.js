'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { executeScheduledEvent } = require('../lib/server/scheduled-task-events');
const { createScheduledTaskService } = require('../lib/server/scheduled-task-service');

function createDeps(overrides = {}) {
  const calls = [];
  const records = [
    { accountRef: 'acct_a', provider: 'zcode' },
    { accountRef: 'acct_b', provider: 'zcode' }
  ];
  const deps = {
    fs,
    aiHomeDir: os.tmpdir(),
    listAccountCredentialRecords: () => records,
    runActivityClaim: async (input) => {
      calls.push(input);
      return {
        provider: input.provider,
        accountRef: input.record.accountRef,
        actionId: input.actionId,
        status: 'claimed',
        plan: { planId: 'zcode-v3-start-plan-1030-wk', planKind: 'weekend_build' }
      };
    },
    ...overrides
  };
  return { deps, calls };
}

test('计划任务：账号参数为空 = 全部账号，行为与历史一致', async () => {
  const { deps, calls } = createDeps();
  const outcome = await executeScheduledEvent({ eventId: 'activity:zcode:trial_plan', params: {}, deps });
  assert.equal(outcome.status, 'ok');
  assert.deepEqual(calls.map((call) => call.record.accountRef), ['acct_a', 'acct_b']);
  // 摘要按真实成功数，而不是恒为 0/N
  assert.equal(outcome.summary, '领取 2/2 成功');
});

test('计划任务：指定账号只跑子集，参数透传到 handler', async () => {
  const { deps, calls } = createDeps();
  const outcome = await executeScheduledEvent({
    eventId: 'activity:zcode:trial_plan',
    params: { accountRefs: ['acct_b'], planKind: 'weekend_build' },
    deps
  });
  assert.equal(outcome.status, 'ok');
  assert.deepEqual(calls.map((call) => call.record.accountRef), ['acct_b']);
  assert.deepEqual(calls[0].params, { accountRefs: ['acct_b'], planKind: 'weekend_build' });
});

test('计划任务：选中的账号已不存在 → 失败结果（fail-loud），不是静默少跑', async () => {
  const { deps, calls } = createDeps();
  const outcome = await executeScheduledEvent({
    eventId: 'activity:zcode:trial_plan',
    params: { accountRefs: ['acct_a', 'acct_gone'] },
    deps
  });
  assert.equal(calls.length, 1);
  assert.equal(outcome.status, 'error');
  const missing = outcome.results.find((row) => row.accountRef === 'acct_gone');
  assert.equal(missing.status, 'error');
  assert.equal(missing.error, 'account_not_found');
});

test('计划任务：非法参数在执行前就被拒（不发起任何领取）', async () => {
  const { deps, calls } = createDeps();
  const outcome = await executeScheduledEvent({
    eventId: 'activity:zcode:trial_plan',
    params: { planKind: 'not_a_kind' },
    deps
  });
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.error, 'activity_param_value_invalid:planKind');
  assert.equal(calls.length, 0);
});

test('计划任务保存：参数按 schema 归一，非法值拒绝并给出可读错误码', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-stask-'));
  try {
    const service = createScheduledTaskService({ fs, aiHomeDir: dir, now: () => 1_800_000_000_000 });
    const created = service.upsert({
      eventId: 'activity:zcode:trial_plan',
      eventParams: { accountRefs: ['b', 'a', 'b'], planKind: 'weekend_build', junk: 1 },
      schedule: { kind: 'daily', at: '20:00' }
    });
    assert.equal(created.ok, true);
    // 去重 + 排序 + 丢弃未知 key
    assert.deepEqual(created.task.eventParams, {
      accountRefs: ['a', 'b'],
      planKind: 'weekend_build'
    });

    const rejected = service.upsert({
      eventId: 'activity:zcode:trial_plan',
      eventParams: { planKind: 'nope' },
      schedule: { kind: 'daily', at: '20:00' }
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error, 'event_params_invalid:activity_param_value_invalid:planKind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
