'use strict';

// Provider 用量展示端口 —— 注册表视图（**不再有 USAGE_MODULES 常量数组**）。
//
// 每个 provider 的用量能力写在它自己的描述符里（`lib/providers/defs/<id>.js` 的 `usage` 能力，
// 实现通常是 `lib/usage/provider-usage/<id>.js`），本文件只负责把能力投影成调用方要的形状：
//   id / capability='provider.usage'
//   snapshotKind       该 provider 产出的用量快照 kind（取自 usage-remaining 的 USAGE_SNAPSHOT_KINDS）
//   accountSnapshotRefresh  读取账号状态时按需刷新用量快照
//   ptyUsageStatus     PTY 会话在终端标题显示用量
//   planLabel(planType, { rateLimitTier })? → 套餐展示名；'' 表示不显示
//   cachedAccountMetadata(snapshotAccount)? → 账号页缓存元数据（邮箱/套餐等）
//   liveAccountIdentity(ctx)? → 实时账号记录的套餐与主标识补丁；null 表示沿用默认值
//
// 没有声明 usage 能力的 provider 走中性默认实现（不刷新快照、不显示标题用量、无套餐标签）。

const { USAGE_SNAPSHOT_KINDS } = require('../../account/usage-remaining');
const { getProviderCapability, listProviders } = require('../../providers');

const DEFAULT_USAGE_STRATEGY = Object.freeze({
  id: '',
  capability: 'provider.usage',
  snapshotKind: '',
  accountSnapshotRefresh: false,
  ptyUsageStatus: false,
  planLabel: () => ''
});

function getProviderUsageStrategy(provider, options = {}) {
  const id = String(provider || '').trim().toLowerCase();
  const usage = getProviderCapability(id, 'usage', options);
  if (!usage) return DEFAULT_USAGE_STRATEGY;
  return Object.freeze({
    ...DEFAULT_USAGE_STRATEGY,
    snapshotKind: USAGE_SNAPSHOT_KINDS[id] || '',
    ...usage,
    id,
    capability: 'provider.usage'
  });
}

// 兼容旧调用方：声明了 usage 能力的 provider 端口列表（倒排索引驱动，不是手写数组）。
const USAGE_MODULES = Object.freeze(listProviders('usage').map((id) => getProviderUsageStrategy(id)));

module.exports = {
  USAGE_MODULES,
  getProviderUsageStrategy
};
