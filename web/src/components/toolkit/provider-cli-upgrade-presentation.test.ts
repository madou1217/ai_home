import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatUpgradeInterval,
  formatUpgradeTimestamp,
  formatUpgradeVersions,
  getProviderCliUpgradeRow,
  getProviderCliUpgradeRows,
  getUpgradeChannelLabel,
  getUpgradeModeSummary,
  getUpgradeReasonLabel
} from './provider-cli-upgrade-presentation.ts';

const NOW = 1_757_000_000_000;
const CHECK_ONLY = { enabled: true, applyEnabled: false, intervalMs: 6 * 60 * 60 * 1000 };
const AUTO_APPLY = { enabled: true, applyEnabled: true, intervalMs: 6 * 60 * 60 * 1000 };

function record(overrides = {}) {
  return { provider: 'codex', lastCheckAt: NOW - 1000, ...overrides };
}

test('渠道与原因映射成中文,未知值原样保留', () => {
  assert.equal(getUpgradeChannelLabel('standalone_release'), '官方版本化安装');
  assert.equal(getUpgradeChannelLabel(''), '未检测');
  assert.equal(getUpgradeChannelLabel('brand_new_channel'), 'brand_new_channel');
  assert.equal(getUpgradeReasonLabel('deferred_busy'), '该 CLI 正在使用，本轮推迟');
  assert.equal(getUpgradeReasonLabel('soaking'), '新版本静置观察中');
  // 认不出来就原样露出内部枚举，不粉饰成已知状态。
  assert.equal(getUpgradeReasonLabel('some_future_reason'), 'some_future_reason');
  assert.equal(getUpgradeReasonLabel(''), '');
});

test('版本对照文案', () => {
  assert.equal(formatUpgradeVersions({ provider: 'codex' }), '未知');
  assert.equal(formatUpgradeVersions({ provider: 'codex', installedVersion: '1.0.0' }), '1.0.0');
  assert.equal(formatUpgradeVersions({ provider: 'codex', installedVersion: '1.0.0', latestVersion: '1.0.0' }), '1.0.0');
  assert.equal(formatUpgradeVersions({ provider: 'codex', installedVersion: '1.0.0', latestVersion: '1.1.0' }), '1.0.0 → 1.1.0');
  assert.equal(formatUpgradeVersions({ provider: 'codex', latestVersion: '1.1.0' }), '远端 1.1.0');
});

test('时间与周期文案', () => {
  assert.equal(formatUpgradeTimestamp(0, NOW), '从未');
  assert.equal(formatUpgradeTimestamp(NOW - 5_000, NOW), '刚刚');
  assert.equal(formatUpgradeTimestamp(NOW - 5 * 60 * 1000, NOW), '5 分钟前');
  assert.equal(formatUpgradeTimestamp(NOW - 3 * 60 * 60 * 1000, NOW), '3 小时前');
  assert.equal(formatUpgradeTimestamp(NOW - 2 * 24 * 60 * 60 * 1000, NOW), '2 天前');
  assert.equal(formatUpgradeInterval(6 * 60 * 60 * 1000), '6 小时');
  assert.equal(formatUpgradeInterval(45 * 60 * 1000), '45 分钟');
  assert.equal(formatUpgradeInterval(0), '');
});

// 顶部那句话得先回答「会不会动我的机器」。
test('模式摘要区分仅检查与自动升级', () => {
  const checkOnly = getUpgradeModeSummary(CHECK_ONLY);
  assert.equal(checkOnly.label, '仅检查');
  assert.match(checkOnly.detail, /不会安装/);

  const auto = getUpgradeModeSummary(AUTO_APPLY);
  assert.equal(auto.label, '自动升级');
  assert.match(auto.detail, /每 6 小时/);

  assert.equal(getUpgradeModeSummary({ enabled: false }).label, '已关闭');
  assert.equal(getUpgradeModeSummary(null).label, '状态不可用');
  // 全局熔断压过一切。
  const halted = getUpgradeModeSummary(AUTO_APPLY, { enabled: false, disabledReason: 'manual' });
  assert.equal(halted.label, '已全局停用');
  assert.equal(halted.tone, 'error');
});

// 账本第一次写出来之前不能显示成「已是最新」——那是编造出来的好消息。
test('从没查过时是「待首轮检查」而不是「已是最新」', () => {
  const row = getProviderCliUpgradeRow({ provider: 'gemini', lastCheckAt: 0 }, CHECK_ONLY, NOW);
  assert.equal(row.statusLabel, '待首轮检查');
  assert.equal(row.statusTone, 'neutral');
  assert.equal(row.lastCheckText, '从未');
  assert.equal(row.attention, false);
});

test('有新版时按是否自动应用给不同措辞', () => {
  const base = record({ installedVersion: '0.153.4', latestVersion: '0.154.0', updateAvailable: true, lastTickReason: 'apply_disabled' });
  assert.equal(getProviderCliUpgradeRow(base, CHECK_ONLY, NOW).statusLabel, '有新版');
  assert.equal(getProviderCliUpgradeRow(base, AUTO_APPLY, NOW).statusLabel, '待升级');
  assert.equal(getProviderCliUpgradeRow(base, CHECK_ONLY, NOW).versionText, '0.153.4 → 0.154.0');
  assert.equal(getProviderCliUpgradeRow(base, CHECK_ONLY, NOW).reasonText, '仅检查，未安装');
});

test('忙时显示已推迟,且不算需要人管', () => {
  const row = getProviderCliUpgradeRow(record({ lastTickReason: 'deferred_busy', updateAvailable: true }), CHECK_ONLY, NOW);
  assert.equal(row.statusLabel, '已推迟（忙）');
  assert.equal(row.statusTone, 'active');
  assert.equal(row.attention, false);
});

// 坏消息永远盖过好消息：熔断即使 updateAvailable 也不能显示成「有新版」。
test('熔断与回滚标为需要人管', () => {
  const broken = getProviderCliUpgradeRow(
    record({ enabled: false, disabledReason: 'rollback_install_failed', updateAvailable: true }),
    CHECK_ONLY,
    NOW
  );
  assert.equal(broken.statusLabel, '已熔断');
  assert.equal(broken.statusTone, 'error');
  assert.equal(broken.attention, true);
  assert.equal(broken.reasonText, '回滚安装失败');

  const rolledBack = getProviderCliUpgradeRow(record({ state: 'rolled_back' }), CHECK_ONLY, NOW);
  assert.equal(rolledBack.statusLabel, '已回滚');
  assert.equal(rolledBack.statusTone, 'warning');
  assert.equal(rolledBack.attention, true);

  const baseline = getProviderCliUpgradeRow(record({ state: 'baseline_unhealthy' }), CHECK_ONLY, NOW);
  assert.equal(baseline.statusLabel, '当前版本异常');
  assert.equal(baseline.attention, true);
});

test('检查失败照实显示原始错误', () => {
  const row = getProviderCliUpgradeRow(record({ lastCheckError: 'getaddrinfo ENOTFOUND' }), CHECK_ONLY, NOW);
  assert.equal(row.statusLabel, '检查失败');
  assert.equal(row.reasonText, 'getaddrinfo ENOTFOUND');
});

test('已是最新的常态', () => {
  const row = getProviderCliUpgradeRow(
    record({ installedVersion: '1.0.0', latestVersion: '1.0.0', lastTickReason: 'up_to_date', channel: 'npm_global' }),
    CHECK_ONLY,
    NOW
  );
  assert.equal(row.statusLabel, '已是最新');
  assert.equal(row.statusTone, 'success');
  assert.equal(row.channelLabel, 'npm 全局');
  assert.equal(row.reasonText, '已是最新版');
});

test('整份响应映射成行,空响应给空数组', () => {
  assert.deepEqual(getProviderCliUpgradeRows(null), []);
  const rows = getProviderCliUpgradeRows({
    ok: true,
    scheduler: CHECK_ONLY,
    global: { enabled: true, disabledReason: '' },
    providers: [record({ lastCheckAt: 0 }), record({ provider: 'gemini', lastTickReason: 'up_to_date' })]
  }, NOW);
  assert.deepEqual(rows.map((row) => row.statusLabel), ['待首轮检查', '已是最新']);
});
