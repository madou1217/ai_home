'use strict';

// 额度（Remaining）抽象的门面 —— 消费方只 import 这里。
//
// 这一层的存在意义：额度此前散落在「provider 合同能力 + usage-remaining kind 表 +
// usage/cache 可信名单 + accounts.js 逐 provider 分支 + snapshot.js 探针表」五处，
// 没有原生额度接口的 provider 无处安放。现在：
//
//   * **谁提供额度** → `listQuotaProviders()`（原生源 ∪ 插件）
//   * **可信快照长什么样** → `resolveQuotaTrustRule(provider)` / `isTrustedQuotaSnapshot()`
//   * **怎么探测** → 原生走既有 handler；插件走 `createQuotaProbe(provider, deps)`
//
// 原生源的事实表在 `native-sources.js`（数据），插件在 `plugins/` 与用户插件目录（行为），
// 注册表把两者合成同一个视图（`registry.js`）。

const nodePath = require('node:path');
const nodeOs = require('node:os');

const { createQuotaProviderRegistry } = require('./registry');
const { buildNativeQuotaSources } = require('./native-sources');
const { loadQuotaPlugins } = require('./loader');

let cachedRegistry = null;

function resolveDefaultAiHomeDir(env = process.env) {
  const explicit = String(env.AIH_HOME_DIR || env.AIH_HOME || env.AI_HOME || '').trim();
  return explicit || nodePath.join(nodeOs.homedir(), '.ai_home');
}

/**
 * 组装一个独立的注册表（含原生源与插件），供测试与需要自定义目录的调用方使用。
 * @returns {{registry: object, loaded: Array<object>, errors: Array<object>}}
 */
function createQuotaRegistry(options = {}) {
  const registry = createQuotaProviderRegistry({
    nativeSources: buildNativeQuotaSources(options.usageSources)
  });
  const loaded = loadQuotaPlugins({
    registry,
    fs: options.fs,
    env: options.env || process.env,
    aiHomeDir: options.aiHomeDir || resolveDefaultAiHomeDir(options.env || process.env),
    builtinDir: options.builtinDir,
    requireFn: options.requireFn
  });
  return { registry, loaded: loaded.loaded, errors: loaded.errors };
}

/**
 * 进程级单例（懒加载；额度源集合在进程内是常量，不需要热更新）。
 * 注意：单例只认**第一次**调用时的 options；要在同一进程里换插件目录/aiHomeDir（测试、
 * 多租户诊断），请用 `createQuotaRegistry()` 拿独立实例并通过 `{ registry }` 传入。
 */
function getQuotaRegistry(options = {}) {
  if (options.registry) return options.registry;
  if (!cachedRegistry) cachedRegistry = createQuotaRegistry(options).registry;
  return cachedRegistry;
}

function listQuotaProviders(options = {}) {
  return getQuotaRegistry(options).listProviders();
}

function hasQuotaProvider(provider, options = {}) {
  return getQuotaRegistry(options).has(provider);
}

function describeQuotaProvider(provider, options = {}) {
  return getQuotaRegistry(options).get(provider);
}

function listQuotaSources(options = {}) {
  return getQuotaRegistry(options).listSources();
}

/**
 * 按条目语义取快照 kind。`'window'` = 滚动时间窗条目（可做「5h: 91%」展示），
 * 展示层据此判断，不再各写一份 kind 名单。
 */
function listQuotaSnapshotKinds(entryShape = '', options = {}) {
  try {
    return getQuotaRegistry(options).listSnapshotKinds(entryShape);
  } catch (_error) {
    // 注册表不可用时退化成原生源（插件加载失败不该让 codex/claude 的展示消失）。
    const kinds = new Set();
    for (const source of buildNativeQuotaSources(options.usageSources)) {
      if (entryShape && (source.entryShape || 'window') !== entryShape) continue;
      if (source.snapshotKind) kinds.add(source.snapshotKind);
    }
    return [...kinds].sort();
  }
}

/** @returns {{kind: string, sources: Set<string>, shape: string|null}|null} */
function resolveQuotaTrustRule(provider, options = {}) {
  return getQuotaRegistry(options).trustRule(provider);
}

function isTrustedQuotaSnapshot(provider, snapshot, trustOptions = {}, options = {}) {
  return getQuotaRegistry(options).isTrustedSnapshot(provider, snapshot, trustOptions);
}

/** 插件探针实例（原生 provider 返回 null，由 usage/snapshot.js 用自己的依赖构造）。 */
function createQuotaProbe(provider, deps = {}, options = {}) {
  return getQuotaRegistry(options).createProbe(provider, deps);
}

function listQuotaPluginLoadErrors(options = {}) {
  return getQuotaRegistry(options).listLoadErrors();
}

/**
 * 额度来源的可观察摘要（`aih server status` 等诊断出口共用，便于单测）。
 * @returns {{total: number, native: number, plugins: Array<{id: string, providers: string[]}>, errors: Array<object>}}
 */
function describeQuotaSources(options = {}) {
  const registry = getQuotaRegistry(options);
  const sources = registry.listSources();
  const plugins = sources
    .filter((source) => source.plugin)
    .map((source) => ({ id: source.id, providers: [...source.providers] }));
  return {
    total: sources.length,
    native: sources.length - plugins.length,
    plugins,
    errors: registry.listLoadErrors()
  };
}

/** 诊断行（CLI 直接打印；插件加载失败必须显式可见，不得静默跳过）。 */
function formatQuotaSourceLines(options = {}) {
  const summary = describeQuotaSources(options);
  const pluginLabel = summary.plugins.length > 0
    ? `: ${summary.plugins.map((plugin) => `${plugin.id}→${plugin.providers.join('|')}`).join(',')}`
    : '';
  const lines = [
    `quota sources: ${summary.total} (native=${summary.native}, plugin=${summary.plugins.length}${pluginLabel})`
  ];
  if (summary.errors.length > 0) {
    lines.push(`quota plugin errors: ${summary.errors.length}`);
    for (const error of summary.errors.slice(0, 5)) {
      const detail = error.detail ? ` (${error.detail})` : '';
      lines.push(`  - ${error.code} ${error.target}${detail}`);
    }
  }
  return lines;
}

function resetQuotaRegistryCache() {
  cachedRegistry = null;
}

module.exports = {
  createQuotaRegistry,
  getQuotaRegistry,
  listQuotaProviders,
  hasQuotaProvider,
  describeQuotaProvider,
  listQuotaSources,
  listQuotaSnapshotKinds,
  resolveQuotaTrustRule,
  isTrustedQuotaSnapshot,
  createQuotaProbe,
  listQuotaPluginLoadErrors,
  describeQuotaSources,
  formatQuotaSourceLines,
  resolveDefaultAiHomeDir,
  resetQuotaRegistryCache
};
