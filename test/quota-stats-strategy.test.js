'use strict';

// 统计维度的选择策略：账号证据优先，没证据才问 provider 声明的泛范围。
// 这里锁三件事：
//   1. 声明表来自各 provider 自己的 descriptor，不是共享代码里的白名单；
//   2. 账号证据能把泛范围收窄（Plus 没有 5h 这类）；
//   3. 两边都没有时就是没有窗口维度，不能凭空造出 5h/7天/30天。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getDeclaredQuotaWindows,
  resolveQuotaStatsWindows
} = require('../lib/account/quota-stats-strategy');

test('provider 声明来自各自的 descriptor', () => {
  assert.deepEqual(getDeclaredQuotaWindows('claude'), [300, 10080]);
  assert.deepEqual(getDeclaredQuotaWindows('codex'), [300, 10080]);
  assert.deepEqual(getDeclaredQuotaWindows('cline'), [300, 10080, 43200]);
  assert.deepEqual(getDeclaredQuotaWindows('zcode'), [1440, 10080, 43200]);
  assert.deepEqual(getDeclaredQuotaWindows('agy'), [300]);
});

test('没有窗口的 provider 声明为空，不再回落到写死的三档', () => {
  assert.deepEqual(getDeclaredQuotaWindows('kiro'), []);
  assert.deepEqual(getDeclaredQuotaWindows('codebuddy'), []);
  assert.deepEqual(getDeclaredQuotaWindows('gemini'), []);
  assert.deepEqual(getDeclaredQuotaWindows('not-a-provider'), []);
});

test('账号没有证据时用 provider 的泛范围', () => {
  const result = resolveQuotaStatsWindows({ provider: 'claude' });
  assert.deepEqual(result, { windows: [300, 10080], source: 'provider' });
});

test('账号快照收窄泛范围：Plus 没有 5h 就只剩周窗口', () => {
  const result = resolveQuotaStatsWindows({
    provider: 'claude',
    snapshotWindows: [10080]
  });
  assert.deepEqual(result, { windows: [10080], source: 'account' });
});

test('账号证据里出现声明之外的窗口时以证据为准', () => {
  const result = resolveQuotaStatsWindows({
    provider: 'claude',
    observedWindows: [300],
    snapshotWindows: [10080, 43200]
  });
  assert.deepEqual(result, { windows: [300, 10080, 43200], source: 'account' });
});

test('provider 没声明但账号有证据：用证据', () => {
  const result = resolveQuotaStatsWindows({
    provider: 'kimi',
    snapshotWindows: [10080]
  });
  assert.deepEqual(result, { windows: [10080], source: 'account' });
});

test('两边都没有：没有窗口维度', () => {
  const result = resolveQuotaStatsWindows({ provider: 'kiro' });
  assert.deepEqual(result, { windows: [], source: 'none' });
});

test('脏值（0 / 负数 / 小数 / 字符串）不进维度', () => {
  const result = resolveQuotaStatsWindows({
    provider: 'kiro',
    observedWindows: [0, -5, 12.5, 'abc'],
    snapshotWindows: [null, undefined]
  });
  assert.deepEqual(result, { windows: [], source: 'none' });
});
