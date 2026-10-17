'use strict';

// 自动应用默认开之后，「怎么关掉」就不再是可有可无的旁支了：它是这个功能唯一
// 不动用户全局环境的出口。这几条断言钉住那条出口，以及默认值本身。
// 配置只从命令行来（env 回退已删除）。

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseServerServeArgs } = require('../lib/server/args');

test('provider CLI 自动升级默认检查开、应用开、5 分钟一轮', () => {
  const parsed = parseServerServeArgs([]);
  assert.equal(parsed.providerCliAutoUpgrade, true);
  assert.equal(parsed.providerCliAutoUpgradeApply, true);
  assert.equal(parsed.providerCliAutoUpgradeStartDelayMs, 5 * 60 * 1000);
  assert.equal(parsed.providerCliAutoUpgradeIntervalMs, 5 * 60 * 1000);
});

test('--no-provider-cli-auto-upgrade-apply 退回只检查、不改动', () => {
  const parsed = parseServerServeArgs(['--no-provider-cli-auto-upgrade-apply']);
  assert.equal(parsed.providerCliAutoUpgrade, true);
  assert.equal(parsed.providerCliAutoUpgradeApply, false);
});

test('--provider-cli-auto-upgrade-apply 可显式打回应用开关', () => {
  const parsed = parseServerServeArgs(['--provider-cli-auto-upgrade-apply']);
  assert.equal(parsed.providerCliAutoUpgradeApply, true);
});

test('整条关掉时应用开关不再有意义，但字段仍归一化成布尔', () => {
  const parsed = parseServerServeArgs(['--no-provider-cli-auto-upgrade']);
  assert.equal(parsed.providerCliAutoUpgrade, false);
  assert.equal(typeof parsed.providerCliAutoUpgradeApply, 'boolean');
});

test('间隔低于 5 分钟回落默认值', () => {
  assert.equal(
    parseServerServeArgs(['--provider-cli-auto-upgrade-interval-ms', '1000']).providerCliAutoUpgradeIntervalMs,
    5 * 60 * 1000
  );
  assert.equal(
    parseServerServeArgs(['--provider-cli-auto-upgrade-interval-ms', String(45 * 60 * 1000)]).providerCliAutoUpgradeIntervalMs,
    45 * 60 * 1000
  );
});
