'use strict';

const { USAGE_SNAPSHOT_KINDS } = require('../../account/usage-remaining');

/**
 * Provider 用量端口注册表：每家 provider 一个模块，承载它私有的用量 / 额度 / 套餐知识；
 * 调用方只依赖端口。没有模块的 provider 走中性默认实现（不刷新快照、不在终端标题显示用量、无套餐标签）。
 *
 * 契约（与 contracts/plugins 的 id / capability 对齐）：
 * - id / capability='provider.usage'
 * - snapshotKind: 该 provider 产出的用量快照 kind（取自 usage-remaining 的 USAGE_SNAPSHOT_KINDS，不另立注册表）
 * - accountSnapshotRefresh: 读取账号状态时按需刷新用量快照
 * - ptyUsageStatus: PTY 会话在终端标题显示用量
 * - planLabel(planType, { rateLimitTier })? → 套餐展示名；'' 表示不显示
 */
const USAGE_MODULES = Object.freeze([
  require('./codex'),
  require('./claude'),
  require('./gemini'),
  require('./agy'),
  require('./kimi')
]);

const DEFAULT_USAGE_STRATEGY = Object.freeze({
  id: '',
  capability: 'provider.usage',
  snapshotKind: '',
  accountSnapshotRefresh: false,
  ptyUsageStatus: false,
  planLabel: () => ''
});

const STRATEGY_BY_ID = new Map(USAGE_MODULES.map((module) => [
  module.id,
  Object.freeze({ ...DEFAULT_USAGE_STRATEGY, snapshotKind: USAGE_SNAPSHOT_KINDS[module.id] || '', ...module })
]));

function getProviderUsageStrategy(provider) {
  return STRATEGY_BY_ID.get(String(provider || '').trim().toLowerCase()) || DEFAULT_USAGE_STRATEGY;
}

module.exports = {
  USAGE_MODULES,
  getProviderUsageStrategy
};
