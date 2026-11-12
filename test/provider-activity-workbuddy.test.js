'use strict';

// 签到能力的**挂载面**回归（2026-11-01 实测口径）：
//   * 只有 CN 站有活动。国际站两支（workbuddy / codebuddy）的
//     checkin-activity-status 恒返回 active:false，挂上去就是个永远「暂无可领」的死菜单。
//   * CN 站两支（workbuddycn / codebuddycn）是同一个账号（同 uid、共用一份凭据），
//     签到接口按 uid 记账，所以两支都能领同一份每日奖励。

const test = require('node:test');
const assert = require('node:assert/strict');

const { getProviderCapability, listProviders } = require('../lib/providers');
const { ACTIVITY_HANDLERS } = require('../lib/account/activity-claim');

test('签到只在 CN 站：国际站两支不声明 activity', () => {
  assert.equal(getProviderCapability('workbuddy', 'activity'), null);
  assert.equal(getProviderCapability('codebuddy', 'activity'), null);
});

test('CN 站两支都声明同一个签到动作，且共用同一个 handler', () => {
  for (const provider of ['workbuddycn', 'codebuddycn']) {
    const capability = getProviderCapability(provider, 'activity');
    assert.ok(capability, provider + ' 应该声明 activity');
    assert.equal(capability.supported, true);
    assert.deepEqual(capability.actions.map((action) => action.id), ['daily_checkin']);
    assert.equal(capability.actions[0].handler, 'workbuddy-daily-checkin');
    assert.equal(capability.actions[0].schedulable, true);
    assert.equal(capability.actions[0].supportsProbe, true);
  }
});

test('签到动作声明了 accountRefs 参数（与 zcode 的「领臭鸡蛋」同形）', () => {
  const action = getProviderCapability('workbuddycn', 'activity').actions[0];
  assert.deepEqual(action.params.map((param) => param.key), ['accountRefs']);
  assert.equal(action.params[0].type, 'account-refs');
  // 空数组 = 不筛（全部账号），老任务不用迁移
  assert.equal(action.params[0].emptyMeans, 'all');
});

test('handler 已注册，且活动 provider 目录里没有国际站', () => {
  assert.ok(ACTIVITY_HANDLERS['workbuddy-daily-checkin']);
  const providers = listProviders('activity');
  assert.ok(providers.includes('workbuddycn'));
  assert.ok(providers.includes('codebuddycn'));
  assert.ok(!providers.includes('workbuddy'));
  assert.ok(!providers.includes('codebuddy'));
});
