'use strict';

// Provider 能力注册表门面 —— 消费方只 import 这里。
//
//   * `listProviders(capability)`：**倒排索引**（能力 → providers），新增 provider 不用改这里；
//   * `getProviderCapability(id, capability)`：provider → 能力；
//   * 描述符来自 `lib/providers/defs/<id>.js`（每个 provider 自己的文件）+ 外部目录；
//   * 加载失败不抛出，进 `listProviderDescriptorLoadErrors()`（可观察）。
//
// 额度（quota）领域语义在 `lib/usage/quota`，用量展示端口在 `lib/usage/provider-usage`：
// 两者都只是本注册表的视图，不各自维护 provider 名单。

const nodePath = require('node:path');
const nodeOs = require('node:os');

const { createProviderRegistry } = require('./registry');
const { loadProviderDefinitions } = require('./loader');

let cachedRegistry = null;

function resolveDefaultAiHomeDir(env = process.env) {
  const explicit = String(env.AIH_HOME_DIR || env.AIH_HOME || env.AI_HOME || '').trim();
  return explicit || nodePath.join(nodeOs.homedir(), '.ai_home');
}

/** 组装独立注册表（内置 defs + 外部目录 + 兼容的旧额度插件目录）。 */
function createProvidersRegistry(options = {}) {
  const registry = createProviderRegistry();
  const loaded = loadProviderDefinitions({
    registry,
    fs: options.fs,
    env: options.env || process.env,
    aiHomeDir: options.aiHomeDir || resolveDefaultAiHomeDir(options.env || process.env),
    builtinDir: options.builtinDir,
    legacyPluginDir: options.legacyPluginDir,
    skipLegacy: Boolean(options.skipLegacy),
    requireFn: options.requireFn
  });
  return { registry, loaded: loaded.loaded, errors: loaded.errors };
}

/**
 * 进程级单例（懒加载）。单例只认第一次调用时的 options；同一进程内换目录请用
 * `createProvidersRegistry()` 拿独立实例并通过 `{ registry }` 传入。
 */
function getProviderRegistry(options = {}) {
  if (options.registry) return options.registry;
  if (!cachedRegistry) cachedRegistry = createProvidersRegistry(options).registry;
  return cachedRegistry;
}

/** 倒排：声明了该能力的 provider 列表。 */
function listProviders(capability, options = {}) {
  return getProviderRegistry(options).listProviders(capability);
}

function listCapabilityIndex(options = {}) {
  return getProviderRegistry(options).listCapabilityIndex();
}

function getProviderDescriptor(id, options = {}) {
  return getProviderRegistry(options).get(id);
}

function getProviderCapability(id, capability, options = {}) {
  return getProviderRegistry(options).getCapability(id, capability);
}

function supportsProviderCapability(id, capability, options = {}) {
  return getProviderRegistry(options).supports(id, capability);
}

function listProviderDescriptorLoadErrors(options = {}) {
  return getProviderRegistry(options).listLoadErrors();
}

function resetProviderRegistryCache() {
  cachedRegistry = null;
}

/** 诊断行：能力倒排 + 加载错误（`aih server status` 等出口共用，便于单测）。 */
function formatProviderCapabilityLines(options = {}) {
  const registry = getProviderRegistry(options);
  const index = registry.listCapabilityIndex();
  const lines = [`provider capabilities: ${Object.keys(index).length} kind(s) over ${registry.listIds().length} provider(s)`];
  for (const capability of Object.keys(index)) {
    lines.push(`  ${capability}: ${index[capability].join(',') || '(none)'}`);
  }
  const errors = registry.listLoadErrors();
  if (errors.length > 0) {
    lines.push(`provider descriptor errors: ${errors.length}`);
    for (const error of errors.slice(0, 5)) {
      const detail = error.detail ? ` (${error.detail})` : '';
      lines.push(`  - ${error.code} ${error.target}${detail}`);
    }
  }
  return lines;
}

module.exports = {
  createProvidersRegistry,
  getProviderRegistry,
  listProviders,
  listCapabilityIndex,
  getProviderDescriptor,
  getProviderCapability,
  supportsProviderCapability,
  listProviderDescriptorLoadErrors,
  formatProviderCapabilityLines,
  resolveDefaultAiHomeDir,
  resetProviderRegistryCache
};
