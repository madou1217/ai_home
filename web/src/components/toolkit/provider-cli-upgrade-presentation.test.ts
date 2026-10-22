import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeClearBrokenResult,
  formatUpgradeInterval,
  formatUpgradeTimestamp,
  formatUpgradeVersions,
  getManagedAppUpgradeView,
  getManagedAppUpgradeViews,
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

// 有新版不再写标签：界面上由更新图标右上角的黄点表达。statusLabel 为空是刻意的，
// 卡片据此不渲染那一行——「待升级」不是状态也不是动作，读者看完不知道该做什么。
test('有新版时不产生状态文案，只标记 hasUpdate', () => {
  const base = record({ installedVersion: '0.153.4', latestVersion: '0.154.0', updateAvailable: true, lastTickReason: 'apply_disabled' });
  for (const scheduler of [CHECK_ONLY, AUTO_APPLY]) {
    const row = getProviderCliUpgradeRow(base, scheduler, NOW);
    assert.equal(row.statusLabel, '');
    assert.equal(row.hasUpdate, true);
  }
  assert.equal(getProviderCliUpgradeRow(base, CHECK_ONLY, NOW).versionText, '0.153.4 → 0.154.0');
  assert.equal(getProviderCliUpgradeRow(base, CHECK_ONLY, NOW).reasonText, '仅检查，未安装');
  // 渠道钉不了版本也一样：反正不写标签。
  const unpinnable = { ...base, lastTickReason: 'channel_not_pinnable' };
  assert.equal(getProviderCliUpgradeRow(unpinnable, AUTO_APPLY, NOW).statusLabel, '');
  assert.equal(getUpgradeReasonLabel('busy'), '该 CLI 正在使用，本轮推迟');
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

test('找得到命令却读不到版本 = 版本未知,不是未安装也不是已是最新', () => {
  const row = getProviderCliUpgradeRow(
    record({ installedVersion: '', resolvedPath: 'd:\\nvm4w\\nodejs\\codex.cmd', lastTickReason: 'installed_version_unknown' }),
    CHECK_ONLY,
    NOW
  );
  assert.equal(row.statusLabel, '版本未知');
  assert.equal(row.statusTone, 'warning');
  assert.equal(row.installed, true);
});

test('查过但找不到命令 = 未安装,不显示已是最新与渠道结论', () => {
  const row = getProviderCliUpgradeRow(
    record({ installedVersion: '', latestVersion: '1.1.65', channel: 'unknown', lastTickReason: 'channel_not_pinnable', state: 'healthy' }),
    CHECK_ONLY,
    NOW
  );
  assert.equal(row.installed, false);
  assert.equal(row.statusLabel, '未安装');
  assert.equal(row.statusTone, 'neutral');
  assert.equal(row.reasonText, '');
  assert.equal(row.channelLabel, '—');
  assert.equal(row.attention, false);
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
    providers: [record({ lastCheckAt: 0 }), record({ provider: 'gemini', installedVersion: '0.9.0', lastTickReason: 'up_to_date' })]
  }, NOW);
  assert.deepEqual(rows.map((row) => row.statusLabel), ['待首轮检查', '已是最新']);
});

// 熔断后每轮 tick 的结论都只是 provider_broken(「已熔断」),看不出真正的原因,也没有入口解除。
test('熔断行显示最后一次失败的真实原因,并允许验证后解除', () => {
  const row = getProviderCliUpgradeRow(
    record({ state: 'broken', lastTickReason: 'provider_broken', lastApplyError: 'rollback_plan_unavailable' }),
    AUTO_APPLY,
    NOW
  );
  assert.equal(row.statusLabel, '异常');
  assert.equal(row.reasonText, '没有可用的回滚方案');
  assert.equal(row.canClearBroken, true);
  assert.equal(getProviderCliUpgradeRow(record({ state: 'rolled_back' }), AUTO_APPLY, NOW).canClearBroken, false);
});

test('解除熔断的结果文案写清结论与原因', () => {
  assert.match(describeClearBrokenResult({ ok: true, reason: 'cleared', version: '0.158.0' }), /已解除熔断.*0\.158\.0/);
  assert.equal(
    describeClearBrokenResult({ ok: false, reason: 'verify_failed', detail: 'version_mismatch:a!=b' }),
    '当前版本验证不通过，保持熔断（version_mismatch:a!=b）'
  );
});

test('被停用(enabled=false)的熔断行同样可以验证后解除', () => {
  const row = getProviderCliUpgradeRow(record({ enabled: false, disabledReason: 'rollback_plan_unavailable' }), AUTO_APPLY, NOW);
  assert.equal(row.statusLabel, '已熔断');
  assert.equal(row.canClearBroken, true);
});

// 「有新版」是应用卡片上唯一该冒出来的好消息；熔断/回滚时账本里的 updateAvailable
// 仍然为 true，但那不是可跟进的新版，不能盖掉「等人处理」。
test('只有真的要跟进的新版才算 hasUpdate', () => {
  const base = record({ installedVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true });
  assert.equal(getProviderCliUpgradeRow(base, CHECK_ONLY, NOW).hasUpdate, true);
  assert.equal(getProviderCliUpgradeRow({ ...base, enabled: false, disabledReason: 'apply_failed_network' }, CHECK_ONLY, NOW).hasUpdate, false);
  assert.equal(getProviderCliUpgradeRow({ ...base, state: 'rolled_back' }, CHECK_ONLY, NOW).hasUpdate, false);
  assert.equal(getProviderCliUpgradeRow(record({ installedVersion: '1.0.0', updateAvailable: false }), CHECK_ONLY, NOW).hasUpdate, false);
});

// 调度器一轮里逐个 provider 串行，applyingProvider 指到谁，就只该那一张卡片转圈。
test('applying 只落在调度器正在装的那一个 provider 上', () => {
  const applying = { ...AUTO_APPLY, applyingProvider: 'codex' };
  const codex = record({ installedVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true });
  const gemini = record({ provider: 'gemini', installedVersion: '2.0.0', latestVersion: '2.1.0', updateAvailable: true });

  assert.equal(getProviderCliUpgradeRow(codex, applying, NOW).applying, true);
  assert.equal(getProviderCliUpgradeRow(gemini, applying, NOW).applying, false);
  // 没在装的时候谁都不转圈；scheduler 缺席（独立进程/未接线）也不该编造。
  assert.equal(getProviderCliUpgradeRow(codex, AUTO_APPLY, NOW).applying, false);
  assert.equal(getProviderCliUpgradeRow(codex, null, NOW).applying, false);
  assert.equal(getProviderCliUpgradeRow(codex, { ...AUTO_APPLY, applyingProvider: '' }, NOW).applying, false);
});

// 应用卡片与账本是两份数据，只能按 provider 对齐；账本里没有就必须是 null。
test('应用卡片按 provider 取到同一份升级结论', () => {
  const status = {
    ok: true,
    scheduler: AUTO_APPLY,
    global: { enabled: true, disabledReason: '' },
    providers: [
      record({
        installedVersion: '0.153.4',
        latestVersion: '0.154.0',
        updateAvailable: true,
        channel: 'npm_global',
        knownGoodVersion: '0.152.0',
        blockedVersions: ['0.153.9']
      }),
      record({ provider: 'gemini', enabled: false, disabledReason: 'apply_failed_network' })
    ]
  };

  const codex = getManagedAppUpgradeView(status, 'codex', NOW);
  assert.ok(codex);
  assert.equal(codex.provider, 'codex');
  assert.equal(codex.statusLabel, '');
  assert.equal(codex.hasUpdate, true);
  assert.equal(codex.channelLabel, 'npm 全局');
  assert.equal(codex.knownGoodVersion, '0.152.0');
  assert.deepEqual(codex.blockedVersions, ['0.153.9']);

  const gemini = getManagedAppUpgradeView(status, 'gemini', NOW);
  assert.ok(gemini);
  assert.equal(gemini.canClearBroken, true);
  assert.equal(gemini.hasUpdate, false);

  // 账本里没有的 provider（Desktop/IDE、或尚未进候选集）不显示任何升级结论。
  assert.equal(getManagedAppUpgradeView(status, 'claude-desktop', NOW), null);
  assert.equal(getManagedAppUpgradeView(status, '', NOW), null);
  assert.equal(getManagedAppUpgradeView(null, 'codex', NOW), null);

  const all = getManagedAppUpgradeViews(status, NOW);
  assert.deepEqual(Object.keys(all).sort(), ['codex', 'gemini']);
  assert.deepEqual(getManagedAppUpgradeViews(null, NOW), {});
});

// 卡片上「自动升级」这一行已经说了状态；再单列一行「升级结论」只是同义反复
// （「已是最新」→「已是最新版」），用户明确嫌它多余。回归：它只能以「原因」的
// 身份、且只在需要人介入时出现。
test('卡片不再单列「升级结论」，只在需要人介入时给原因', async () => {
  const fs = await import('node:fs');
  const card = fs.readFileSync(new URL('./ManagedAppCard.tsx', import.meta.url), 'utf8');
  const mobile = fs.readFileSync(new URL('../../mobile/pages/toolkit/AppsPanel.tsx', import.meta.url), 'utf8');

  for (const source of [card, mobile]) {
    assert.doesNotMatch(source, /label:\s*'升级结论'/);
    // 原因行必须挂在 attention 上，常态不该冒出来。
    assert.match(source, /upgrade\??\.attention\s*&&\s*upgrade\??\.reasonText/);
  }
});

// 同理：「即时刷新已启用」是每张卡都一样的常态，挂个标签只是噪音。
// 只有「待启用」是一个还没做、且点一下就能做好的动作，才值得提示。
test('即时刷新只在待启用时提示，已启用不占位', async () => {
  const fs = await import('node:fs');
  const card = fs.readFileSync(new URL('./ManagedAppCard.tsx', import.meta.url), 'utf8');
  const mobile = fs.readFileSync(new URL('../../mobile/pages/toolkit/AppsPanel.tsx', import.meta.url), 'utf8');

  for (const source of [card, mobile]) {
    assert.doesNotMatch(source, /即时刷新已启用/);
    // 待启用分支必须同时要求「已安装、支持 hook、且未启用」，否则未安装的卡片也会挂标签。
    assert.match(source, /hookSupported\s*&&\s*!app\.hookInstalled/);
  }
});
