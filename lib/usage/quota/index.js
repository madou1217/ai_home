'use strict';

// 额度（Remaining）领域门面 —— 消费方只 import 这里。
//
// 本文件**不持有任何 provider 名单**：provider 的能力事实写在各自的描述符里
// （`lib/providers/defs/<id>.js` 的 `quota` 能力），这里只做额度领域的派生与执行：
//
//   * 谁有额度            → listQuotaProviders()（注册表倒排 + quota.supported）
//   * 快照长什么样/可信吗 → resolveQuotaTrustRule() / isTrustedQuotaSnapshot()
//   * 时间窗 kind         → listQuotaSnapshotKinds('window')（展示层据此渲染）
//   * 怎么探测            → listQuotaStrategies() + runQuotaStrategies()（策略链）
//   * 诊断                → describeQuotaSources() / formatQuotaSourceLines()

const {
  formatProviderCapabilityLines,
  getProviderCapability,
  getProviderRegistry,
  listProviderDescriptorLoadErrors,
  listProviders,
  resolveDefaultAiHomeDir,
  resetProviderRegistryCache
} = require('../../providers');
const { runQuotaProbe, runQuotaStrategies, summarizeStrategyAttempts } = require('./strategies');

// 探针状态里表示「额度不适用」（结论，不是失败）的前缀：写侧在 usage/snapshot.js，
// 读侧在 account/derived-state.js，两侧共用这两个函数，避免字面量漂移。
const QUOTA_NOT_APPLICABLE_PREFIX = 'quota_not_applicable:';

function formatNotApplicableProbeError(reason) {
  const text = String(reason || '').trim();
  return `${QUOTA_NOT_APPLICABLE_PREFIX}${text || 'not_applicable'}`;
}

function isNotApplicableProbeError(value) {
  return String(value || '').trim().startsWith(QUOTA_NOT_APPLICABLE_PREFIX);
}

function readNotApplicableProbeReason(value) {
  const text = String(value || '').trim();
  return isNotApplicableProbeError(text) ? text.slice(QUOTA_NOT_APPLICABLE_PREFIX.length) : '';
}
const {
  SCOPE_CATEGORY_PRIMARY,
  SCOPE_CATEGORY_GIFT,
  SCOPE_CATEGORY_DETAIL,
  buildQuotaView,
  resolveEntryShape,
  resolveEntryShapeByKind,
  resetKindShapeIndexCache,
  humanizeBucketLabel,
  formatQuotaViewInline,
  formatQuotaViewLines,
  formatScopeInline,
  formatUnits
} = require('./view');
const {
  AGY_GROUP_TITLES,
  resolveAgyQuotaGroupKey,
  groupAgyQuotaModels,
  formatAgyGroupInline,
  formatAgyQuotaGroups
} = require('./agy-groups');

/** 声明了「有额度」的 provider（quota.supported === true）。 */
function listQuotaProviders(options = {}) {
  const registry = getProviderRegistry(options);
  return listProviders('quota', options)
    .filter((provider) => {
      const quota = registry.getCapability(provider, 'quota');
      return Boolean(quota && quota.supported === true);
    });
}

/** 所有对额度问题做过显式回答的 provider（含 supported:false 与其 reason）。 */
function listQuotaAnswers(options = {}) {
  const registry = getProviderRegistry(options);
  return listProviders('quota', options).map((provider) => {
    const quota = registry.getCapability(provider, 'quota');
    return {
      provider,
      supported: Boolean(quota && quota.supported === true),
      reason: String(quota && quota.reason || ''),
      kind: String(quota && quota.kind || ''),
      source: String(quota && quota.source || ''),
      shape: String(quota && quota.shape || ''),
      entryShape: String(quota && quota.entryShape || '')
    };
  });
}

/** provider 的额度能力摘要（含策略链，按默认优先级排序）。 */
function describeQuotaProvider(provider, options = {}) {
  const registry = getProviderRegistry(options);
  const quota = getProviderCapability(provider, 'quota', options);
  if (!quota) return null;
  if (quota.supported !== true) {
    return Object.freeze({ provider: String(provider || '').toLowerCase(), supported: false, reason: quota.reason });
  }
  return Object.freeze({
    provider: String(provider || '').toLowerCase(),
    supported: true,
    kind: quota.kind,
    source: quota.source,
    shape: quota.shape,
    entryShape: quota.entryShape,
    strategies: Object.freeze(registry.listQuotaStrategies(provider).map((strategy) => Object.freeze({
      id: strategy.id,
      transport: strategy.transport,
      clientDependent: strategy.clientDependent,
      clientOptional: strategy.clientOptional,
      handler: strategy.handler,
      description: strategy.description
    })))
  });
}

function listQuotaStrategies(provider, options = {}) {
  return getProviderRegistry(options).listQuotaStrategies(provider);
}

/** 构造某条策略的探针（默认策略 = 最稳的那条；handler 型策略返回 null）。 */
function createQuotaProbe(provider, deps = {}, options = {}) {
  const strategy = getProviderRegistry(options).resolveQuotaStrategy(provider, options.strategyId);
  if (!strategy || !strategy.probe) return null;
  const probe = strategy.probe(deps);
  if (!probe || typeof probe.probe !== 'function') {
    throw new Error(`quota_probe_factory_invalid:${strategy.id}`);
  }
  return probe;
}

/** 可信快照规则：kind / sources / shape 由 provider 描述符给出。 */
function resolveQuotaTrustRule(provider, options = {}) {
  const quota = getProviderCapability(provider, 'quota', options);
  if (!quota || quota.supported !== true) return null;
  return { kind: quota.kind, sources: new Set([quota.source]), shape: quota.shape || null };
}

function isTrustedQuotaSnapshot(provider, snapshot, trustOptions = {}, options = {}) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const rule = resolveQuotaTrustRule(provider, options);
  if (!rule) return false;
  if (trustOptions.schemaVersion !== undefined
    && Number(snapshot.schemaVersion) !== Number(trustOptions.schemaVersion)) return false;
  if (!Number.isFinite(Number(snapshot.capturedAt))) return false;
  if (snapshot.kind !== rule.kind || !rule.sources.has(String(snapshot.source || ''))) return false;
  return !rule.shape || Array.isArray(snapshot[rule.shape]);
}

/** 按条目语义取快照 kind（'window' = 滚动时间窗，展示层据此渲染「5h: 91%」）。 */
function listQuotaSnapshotKinds(entryShape = '', options = {}) {
  const wanted = String(entryShape || '').trim();
  const kinds = new Set();
  for (const provider of listQuotaProviders(options)) {
    const quota = getProviderCapability(provider, 'quota', options);
    if (!quota) continue;
    if (wanted && quota.entryShape !== wanted) continue;
    if (quota.kind) kinds.add(quota.kind);
  }
  return [...kinds].sort();
}

/** 该 provider 是否有额度能力（合同能力 ∪ 描述符声明；derived-state 等消费方用）。 */
function hasQuotaProvider(provider, options = {}) {
  const quota = getProviderCapability(provider, 'quota', options);
  return Boolean(quota && quota.supported === true);
}

/** 在用的条目形态（展示层据此渲染；新增形态会在这里出现，不会被静默忽略）。 */
function listQuotaEntryShapes(options = {}) {
  const shapes = new Set();
  for (const provider of listQuotaProviders(options)) {
    const quota = getProviderCapability(provider, 'quota', options);
    if (quota && quota.entryShape) shapes.add(String(quota.entryShape));
  }
  return [...shapes].sort();
}

/** 诊断摘要（`aih server status` 等出口共用，便于单测）。 */
function describeQuotaSources(options = {}) {
  const registry = getProviderRegistry(options);
  const capable = listQuotaProviders(options);
  const answers = listQuotaAnswers(options);
  return {
    total: answers.length,
    supported: capable.length,
    unsupported: answers
      .filter((answer) => !answer.supported)
      .map((answer) => ({ provider: answer.provider, reason: answer.reason })),
    // 所有策略都依赖本机客户端的 provider（服务器上跑不了的那批）。
    clientDependent: capable.filter((provider) => {
      const strategies = registry.listQuotaStrategies(provider);
      return strategies.length > 0 && strategies.every((strategy) => strategy.clientDependent);
    }),
    errors: listProviderDescriptorLoadErrors(options)
  };
}

function formatQuotaSourceLines(options = {}) {
  const summary = describeQuotaSources(options);
  const lines = [
    `quota sources: ${summary.total} provider(s), with quota=${summary.supported}, no quota=${summary.unsupported.length}`
  ];
  for (const entry of summary.unsupported) {
    lines.push(`  ${entry.provider}: ${entry.reason}`);
  }
  if (summary.clientDependent.length > 0) {
    lines.push(`quota client-dependent: ${summary.clientDependent.join(',')}`);
  }
  for (const line of formatProviderCapabilityLines(options)) {
    if (line.startsWith('provider descriptor errors') || line.startsWith('  - ')) lines.push(line);
  }
  return lines;
}

function listQuotaPluginLoadErrors(options = {}) {
  return listProviderDescriptorLoadErrors(options);
}

function resetQuotaRegistryCache() {
  resetProviderRegistryCache();
  resetKindShapeIndexCache();
}

module.exports = {
  listQuotaProviders,
  listQuotaAnswers,
  describeQuotaProvider,
  listQuotaStrategies,
  createQuotaProbe,
  resolveQuotaTrustRule,
  isTrustedQuotaSnapshot,
  listQuotaSnapshotKinds,
  listQuotaEntryShapes,
  hasQuotaProvider,
  SCOPE_CATEGORY_PRIMARY,
  SCOPE_CATEGORY_GIFT,
  SCOPE_CATEGORY_DETAIL,
  buildQuotaView,
  resolveEntryShape,
  resolveEntryShapeByKind,
  humanizeBucketLabel,
  formatQuotaViewInline,
  formatQuotaViewLines,
  formatScopeInline,
  formatUnits,
  AGY_GROUP_TITLES,
  resolveAgyQuotaGroupKey,
  groupAgyQuotaModels,
  formatAgyGroupInline,
  formatAgyQuotaGroups,
  describeQuotaSources,
  formatQuotaSourceLines,
  listQuotaPluginLoadErrors,
  runQuotaProbe,
  runQuotaStrategies,
  QUOTA_NOT_APPLICABLE_PREFIX,
  formatNotApplicableProbeError,
  isNotApplicableProbeError,
  readNotApplicableProbeReason,
  summarizeStrategyAttempts,
  resolveDefaultAiHomeDir,
  resetQuotaRegistryCache
};
