'use strict';

// `aih <provider> ls` 必须把**模型级**限流显示出来：账号整体 healthy、只有一个
// 模型被 429 / 额度窗口限流时，账号级徽章全都是"正常"，用户只能猜为什么某个模型
// 一直失败。事实来源是 account_state.runtime_state 的 modelCooldowns /
// modelFailureStreaks（WebUI「部分模型受限」同一份数据）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  formatRecoveryClock,
  listActiveModelThrottles,
  buildThrottleBadgeVariants,
  formatModelThrottleBadge
} = require('../lib/cli/services/profile/model-throttle');
const { createProfileListService } = require('../lib/cli/services/profile/list');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { createAccountStateIndex } = require('../lib/account/state-index');

// 固定"现在"= 2026-11-04 12:00 本地时间，时间格式化与时区无关。
const NOW = new Date(2026, 10, 4, 12, 0, 0).getTime();
const at = (hour, minute, day = 4) => new Date(2026, 10, day, hour, minute, 0).getTime();

function runtimeState(cooldowns, streaks = {}) {
  return { modelCooldowns: cooldowns, modelFailureStreaks: streaks };
}

test('生效中的模型冷却按恢复时刻排序，过期的丢弃', () => {
  const state = runtimeState(
    { 'model-b': at(15, 0), 'model-a': at(13, 30), 'model-old': at(11, 0) },
    {
      'model-b': { kind: 'rate_limited', count: 1, expiresAt: at(15, 0) },
      'model-a': { kind: 'rate_limited', count: 1, expiresAt: at(15, 0) },
      'model-old': { kind: 'rate_limited', count: 1, expiresAt: at(15, 0) }
    }
  );
  assert.deepEqual(
    listActiveModelThrottles(state, NOW).map((entry) => [entry.model, entry.until, entry.kind]),
    [
      ['model-a', at(13, 30), 'rate_limited'],
      ['model-b', at(15, 0), 'rate_limited']
    ]
  );
});

test('单个模型限流：一条精简徽章，当天只给 HH:MM', () => {
  const badges = buildThrottleBadgeVariants(runtimeState(
    { 'deepseek-v4.1-flash': at(14, 29) },
    { 'deepseek-v4.1-flash': { kind: 'model_quota_exhausted', count: 1, expiresAt: at(14, 29) } }
  ), null, NOW);
  assert.deepEqual(badges, ['\x1b[33m[限流: deepseek-v4.1-flash 至 14:29]\x1b[0m']);
});

test('跨天恢复补上日期，避免看起来像"已经过去的时刻"', () => {
  const badges = buildThrottleBadgeVariants(runtimeState(
    { 'gemini-3.8-flash': at(0, 10, 5) },
    { 'gemini-3.8-flash': { kind: 'rate_limited', count: 1, expiresAt: at(15, 0) } }
  ), null, NOW);
  assert.match(badges[0], /限流: gemini-3\.8-flash 至 11-05 00:10/);
  assert.equal(formatRecoveryClock(at(0, 10, 5), NOW), '11-05 00:10');
});

test('非限流类原因说"受限"，不冒称限流', () => {
  const badges = buildThrottleBadgeVariants(runtimeState(
    { 'gemini-3.8-flash': at(13, 0) },
    { 'gemini-3.8-flash': { kind: 'account_tier_model_denied', count: 1, expiresAt: at(13, 0) } }
  ), null, NOW);
  assert.match(badges[0], /受限: gemini-3\.8-flash 至 13:00/);
  assert.ok(!badges.join('').includes('限流'));
});

test('多个模型限流：拆成多条候选（交给展示层轮换，不再堆在一行）', () => {
  const cooldowns = {};
  const streaks = {};
  ['m1', 'm2', 'm3', 'm4', 'm5'].forEach((model, index) => {
    const until = at(13, 0) + index * 60 * 1000;
    cooldowns[model] = until;
    streaks[model] = { kind: 'rate_limited', count: 1, expiresAt: at(15, 0) };
  });
  const badges = buildThrottleBadgeVariants(runtimeState(cooldowns, streaks), null, NOW);
  assert.equal(badges.length, 5);
  assert.match(badges[0], /限流: m1 至 13:00/);
  assert.match(badges[4], /限流: m5 至 13:04/);
});

test('账号级限流也显示，且排在具体模型之前（与 WebUI rate_limited 对齐）', () => {
  const badges = buildThrottleBadgeVariants(
    runtimeState(
      { 'deepseek-v4.1-flash': at(14, 29) },
      { 'deepseek-v4.1-flash': { kind: 'rate_limited', count: 1, expiresAt: at(14, 29) } }
    ),
    { status: 'rate_limited', until: at(12, 30) },
    NOW
  );
  assert.match(badges[0], /限流: 账号 至 12:30/);
  assert.match(badges[1], /限流: deepseek-v4\.1-flash 至 14:29/);
});

test('没有冷却 / 数据残缺时不渲染徽章', () => {
  assert.deepEqual(buildThrottleBadgeVariants(null, null, NOW), []);
  assert.deepEqual(buildThrottleBadgeVariants({}, null, NOW), []);
  assert.deepEqual(buildThrottleBadgeVariants(runtimeState({}), null, NOW), []);
  assert.deepEqual(buildThrottleBadgeVariants(runtimeState({ 'x': at(11, 0) }), null, NOW), []);
  assert.deepEqual(buildThrottleBadgeVariants('not-an-object', null, NOW), []);
  assert.equal(formatModelThrottleBadge(null, NOW), '');
});

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-ls-model-throttle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('aih <provider> ls 的每一行带上模型限流徽章', async (t) => {
  const aiHomeDir = tempHome(t);
  const account = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codebuddy',
    identitySeed: 'demo:model-throttle'
  });
  const index = createAccountStateIndex({ fs, aiHomeDir });
  t.after(() => index.close());
  index.upsertRuntimeState(
    account.accountRef,
    'codebuddy',
    runtimeState(
      { 'deepseek-v4.1-flash': at(14, 29) },
      { 'deepseek-v4.1-flash': { kind: 'model_quota_exhausted', count: 1, expiresAt: at(14, 29) } }
    ),
    { status: 'up', configured: true, displayName: 'demo' }
  );

  const service = createProfileListService({
    fs,
    path,
    processObj: {
      platform: 'linux',
      stdout: { isTTY: false, write() {} },
      stdin: {},
      exit() {}
    },
    aiHomeDir,
    cliConfigs: { codebuddy: {} },
    listPageSize: 50,
    getAccountStateIndex: () => index,
    checkStatus: () => ({ configured: true, accountName: 'demo' }),
    formatAccountPlanBadge: () => '',
    formatUsageLabel: () => '',
    refreshIndexedStateForAccount: () => null
  });

  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const listed = service.listProfiles('codebuddy');
    assert.equal(listed.interactive, false);
    await listed.done;
  } finally {
    console.log = originalLog;
  }

  const row = lines.find((line) => line.includes('Account ID:'));
  assert.ok(row, `account row missing: ${lines.join(' | ')}`);
  assert.match(row, /\[限流: deepseek-v4\.1-flash 至 14:29\]/);
});

test('没有模型冷却的账号不会多出徽章', async (t) => {
  const aiHomeDir = tempHome(t);
  const account = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codebuddy',
    identitySeed: 'demo:no-model-throttle'
  });
  const index = createAccountStateIndex({ fs, aiHomeDir });
  t.after(() => index.close());
  index.upsertRuntimeState(account.accountRef, 'codebuddy', runtimeState({}), {
    status: 'up',
    configured: true,
    displayName: 'demo'
  });

  const service = createProfileListService({
    fs,
    path,
    processObj: {
      platform: 'linux',
      stdout: { isTTY: false, write() {} },
      stdin: {},
      exit() {}
    },
    aiHomeDir,
    cliConfigs: { codebuddy: {} },
    listPageSize: 50,
    getAccountStateIndex: () => index,
    checkStatus: () => ({ configured: true, accountName: 'demo' }),
    formatAccountPlanBadge: () => '',
    formatUsageLabel: () => '',
    refreshIndexedStateForAccount: () => null
  });

  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await service.listProfiles('codebuddy').done;
  } finally {
    console.log = originalLog;
  }

  const row = lines.find((line) => line.includes('Account ID:'));
  assert.ok(row, `account row missing: ${lines.join(' | ')}`);
  assert.ok(!row.includes('[限流:'));
});
