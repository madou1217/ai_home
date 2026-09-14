'use strict';

// 自动应用默认开之后，「怎么关掉」就不再是可有可无的旁支了：它是这个功能唯一
// 不动用户全局环境的出口。这几条断言钉住那条出口，以及默认值本身。

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseServerServeArgs } = require('../lib/server/args');

const UPGRADE_ENV_KEYS = [
  'AIH_SERVER_PROVIDER_CLI_AUTO_UPGRADE',
  'AIH_SERVER_PROVIDER_CLI_AUTO_UPGRADE_APPLY',
  'AIH_SERVER_PROVIDER_CLI_AUTO_UPGRADE_START_DELAY_MS',
  'AIH_SERVER_PROVIDER_CLI_AUTO_UPGRADE_INTERVAL_MS'
];

// 默认值是从 process.env 读的，测试之间必须互不串味。
function withEnv(patch, fn) {
  const previous = {};
  UPGRADE_ENV_KEYS.forEach((key) => { previous[key] = process.env[key]; delete process.env[key]; });
  Object.entries(patch).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  try {
    return fn();
  } finally {
    UPGRADE_ENV_KEYS.forEach((key) => {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    });
  }
}

test('provider CLI 自动升级默认检查开、应用开、6 小时一轮', () => {
  withEnv({}, () => {
    const parsed = parseServerServeArgs([]);
    assert.equal(parsed.providerCliAutoUpgrade, true);
    assert.equal(parsed.providerCliAutoUpgradeApply, true);
    assert.equal(parsed.providerCliAutoUpgradeStartDelayMs, 5 * 60 * 1000);
    assert.equal(parsed.providerCliAutoUpgradeIntervalMs, 6 * 60 * 60 * 1000);
  });
});

test('--no-provider-cli-auto-upgrade-apply 退回只检查、不改动', () => {
  withEnv({}, () => {
    const parsed = parseServerServeArgs(['--no-provider-cli-auto-upgrade-apply']);
    // 检查这一半仍然开着：退回的是「动手」，不是「知情」。
    assert.equal(parsed.providerCliAutoUpgrade, true);
    assert.equal(parsed.providerCliAutoUpgradeApply, false);
  });
});

test('AIH_SERVER_PROVIDER_CLI_AUTO_UPGRADE_APPLY=0 同样退回只检查', () => {
  withEnv({ AIH_SERVER_PROVIDER_CLI_AUTO_UPGRADE_APPLY: '0' }, () => {
    const parsed = parseServerServeArgs([]);
    assert.equal(parsed.providerCliAutoUpgradeApply, false);
  });

  // 命令行压过环境变量：env 关了、显式 flag 仍能打开。
  withEnv({ AIH_SERVER_PROVIDER_CLI_AUTO_UPGRADE_APPLY: '0' }, () => {
    const parsed = parseServerServeArgs(['--provider-cli-auto-upgrade-apply']);
    assert.equal(parsed.providerCliAutoUpgradeApply, true);
  });
});

test('整条关掉时应用开关不再有意义,但字段仍归一化成布尔', () => {
  withEnv({ AIH_SERVER_PROVIDER_CLI_AUTO_UPGRADE: '0' }, () => {
    const parsed = parseServerServeArgs([]);
    assert.equal(parsed.providerCliAutoUpgrade, false);
    assert.equal(typeof parsed.providerCliAutoUpgradeApply, 'boolean');
  });

  withEnv({}, () => {
    const parsed = parseServerServeArgs(['--no-provider-cli-auto-upgrade']);
    assert.equal(parsed.providerCliAutoUpgrade, false);
  });
});

// 一轮要 spawn 真二进制（codex 的强判据还要起一次 app-server），不给调成秒级。
test('间隔低于 30 分钟回落默认值', () => {
  withEnv({ AIH_SERVER_PROVIDER_CLI_AUTO_UPGRADE_INTERVAL_MS: '1000' }, () => {
    assert.equal(parseServerServeArgs([]).providerCliAutoUpgradeIntervalMs, 6 * 60 * 60 * 1000);
  });
  withEnv({ AIH_SERVER_PROVIDER_CLI_AUTO_UPGRADE_INTERVAL_MS: String(45 * 60 * 1000) }, () => {
    assert.equal(parseServerServeArgs([]).providerCliAutoUpgradeIntervalMs, 45 * 60 * 1000);
  });
});
