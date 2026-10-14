'use strict';

// 额度源注册表 —— 「谁给某个 provider 提供额度」的唯一答案。
//
// 两类来源：
//   native —— 内核自带实现（codex / claude / agy / gemini / kimi / grok / kiro / zcode /
//             CodeBuddy 家族）。注册表登记它们的 kind / source / shape 事实，
//             探针实例仍由 `lib/cli/services/usage/snapshot.js` 构造（它持有那些依赖）。
//   plugin —— 通过 `lib/usage/quota/plugins/` 或用户插件目录加载的插件，实现统一
//             `probe()` 契约，由 `createProbe()` 构造实例。
//
// 冲突策略：native 优先（插件不得覆盖内核实现）；同一 provider 被两个插件认领时保留
// 先注册者并把后者的失败记为可观察的加载错误（不静默覆盖）。

const { quotaPluginError, validateQuotaPlugin } = require('./contract');

function normalizeProviderId(value) {
  return String(value === undefined || value === null ? '' : value).trim().toLowerCase();
}

function normalizeSourceList(value) {
  return (Array.isArray(value) ? value : [value])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function validateNativeSource(source) {
  const id = normalizeProviderId(source && source.id);
  if (!id) throw quotaPluginError('quota_native_source_id_invalid');
  const providers = [...new Set(
    (Array.isArray(source.providers) ? source.providers : []).map(normalizeProviderId).filter(Boolean)
  )];
  if (providers.length === 0) throw quotaPluginError('quota_native_source_providers_missing', id);
  const sources = normalizeSourceList(source.sources !== undefined ? source.sources : source.source);
  if (sources.length === 0) throw quotaPluginError('quota_native_source_source_missing', id);
  const snapshotKind = String(source.snapshotKind || '').trim();
  if (!snapshotKind) throw quotaPluginError('quota_native_source_kind_missing', id);
  return {
    id,
    providers,
    sources,
    snapshotKind,
    shape: String(source.shape || '').trim() || null,
    entryShape: String(source.entryShape || '').trim() || 'window'
  };
}

function createQuotaProviderRegistry(options = {}) {
  const entries = new Map();
  const sources = new Map();
  const loadErrors = [];

  function registerNativeSource(rawSource) {
    const source = validateNativeSource(rawSource);
    if (sources.has(source.id)) throw quotaPluginError('quota_native_source_duplicate', source.id);
    sources.set(source.id, Object.freeze({ ...source, origin: 'native' }));
    for (const provider of source.providers) {
      if (entries.has(provider)) throw quotaPluginError('quota_native_source_provider_conflict', provider);
      entries.set(provider, {
        origin: 'native',
        sourceId: source.id,
        pluginId: '',
        sources: source.sources,
        snapshotKind: source.snapshotKind,
        shape: source.shape,
        entryShape: source.entryShape,
        plugin: null
      });
    }
    return sources.get(source.id);
  }

  /**
   * 注册一份额度插件（内部先做契约校验）。
   * @throws {QuotaPluginError} 与 native 或已注册插件冲突时抛出；调用方记为加载错误
   */
  function registerPlugin(definition, registerOptions = {}) {
    const plugin = validateQuotaPlugin(definition);
    const origin = registerOptions.origin === 'external' ? 'external' : 'builtin';
    for (const provider of plugin.providers) {
      if (entries.has(provider)) {
        throw quotaPluginError('quota_plugin_provider_conflict', `${plugin.id}:${provider}`);
      }
    }
    sources.set(plugin.id, Object.freeze({
      id: plugin.id,
      providers: plugin.providers,
      sources: [plugin.source],
      snapshotKind: plugin.snapshotKind,
      shape: plugin.shape,
      entryShape: plugin.entryShape,
      origin,
      plugin
    }));
    for (const provider of plugin.providers) {
      entries.set(provider, {
        origin: 'plugin',
        sourceId: plugin.id,
        pluginId: plugin.id,
        sources: [plugin.source],
        snapshotKind: plugin.snapshotKind,
        shape: plugin.shape,
        entryShape: plugin.entryShape,
        plugin
      });
    }
    return sources.get(plugin.id);
  }

  function recordLoadError(error) {
    const code = String(error && error.code || 'quota_plugin_load_failed');
    const rawDetail = String(error && error.detail || '').trim();
    const message = String(error && error.message || '').trim();
    const normalized = {
      code,
      // detail 与 code 相同时不重复展示（契约错误经常没有额外上下文）。
      detail: (rawDetail || (message && message !== code ? message : '')).slice(0, 240),
      target: String(error && error.target || '').slice(0, 240)
    };
    loadErrors.push(Object.freeze(normalized));
    return normalized;
  }

  function get(provider) {
    const key = normalizeProviderId(provider);
    const entry = entries.get(key);
    if (!entry) return null;
    return Object.freeze({
      provider: key,
      origin: entry.origin,
      sourceId: entry.sourceId,
      pluginId: entry.pluginId,
      snapshotKind: entry.snapshotKind,
      source: entry.sources[0],
      sources: Object.freeze([...entry.sources]),
      shape: entry.shape,
      entryShape: entry.entryShape
    });
  }

  function has(provider) {
    return entries.has(normalizeProviderId(provider));
  }

  function listProviders() {
    return [...entries.keys()].sort();
  }

  /** 按条目语义筛出快照 kind（例如 window = 滚动时间窗，可做「5h: 91%」展示）。 */
  function listSnapshotKinds(entryShape) {
    const wanted = String(entryShape || '').trim();
    const kinds = new Set();
    for (const source of sources.values()) {
      if (wanted && source.entryShape !== wanted) continue;
      if (source.snapshotKind) kinds.add(source.snapshotKind);
    }
    return [...kinds].sort();
  }

  function listSources() {
    return [...sources.values()].map((source) => Object.freeze({
      id: source.id,
      origin: source.origin,
      // origin 的取值是 native / builtin / external；插件（内置或外部）都是 plugin=true，
      // 消费方不该自己去猜 'plugin' 这个不存在的字面量。
      plugin: source.origin !== 'native',
      providers: Object.freeze([...source.providers]),
      snapshotKind: source.snapshotKind,
      source: source.sources[0],
      shape: source.shape,
      entryShape: source.entryShape
    }));
  }

  /** 可信快照规则：kind / sources / shape 由注册表给出，消费方不再各写一份名单。 */
  function trustRule(provider) {
    const entry = entries.get(normalizeProviderId(provider));
    if (!entry) return null;
    return {
      kind: entry.snapshotKind,
      sources: new Set(entry.sources),
      shape: entry.shape
    };
  }

  function isTrustedSnapshot(provider, snapshot, trustOptions = {}) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    const rule = trustRule(provider);
    if (!rule) return false;
    if (trustOptions.schemaVersion !== undefined
      && Number(snapshot.schemaVersion) !== Number(trustOptions.schemaVersion)) return false;
    if (!Number.isFinite(Number(snapshot.capturedAt))) return false;
    if (snapshot.kind !== rule.kind || !rule.sources.has(String(snapshot.source || ''))) return false;
    return !rule.shape || Array.isArray(snapshot[rule.shape]);
  }

  /**
   * 构造插件的探针实例（native 探针由 usage/snapshot.js 持有依赖自己构造）。
   * @returns {{ probe: Function }|null}
   */
  function createProbe(provider, deps = {}) {
    const entry = entries.get(normalizeProviderId(provider));
    if (!entry || !entry.plugin) return null;
    const probe = entry.plugin.createProbe(deps);
    if (!probe || typeof probe.probe !== 'function') {
      throw quotaPluginError('quota_plugin_probe_factory_invalid', entry.pluginId);
    }
    return probe;
  }

  for (const nativeSource of (Array.isArray(options.nativeSources) ? options.nativeSources : [])) {
    registerNativeSource(nativeSource);
  }

  return {
    registerNativeSource,
    registerPlugin,
    recordLoadError,
    get,
    has,
    listProviders,
    listSources,
    listSnapshotKinds,
    trustRule,
    isTrustedSnapshot,
    createProbe,
    listLoadErrors: () => [...loadErrors]
  };
}

module.exports = {
  createQuotaProviderRegistry,
  __private: { normalizeProviderId, normalizeSourceList, validateNativeSource }
};
