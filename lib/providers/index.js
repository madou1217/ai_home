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
const { getProviderDefinition } = require('../provider-catalog');
const { resolveAiHomeDir } = require('../runtime/aih-home');

let cachedRegistry = null;

// 数据根目录的唯一规则在 lib/runtime/aih-home.js（AIH_HOME_DIR / AIH_HOME / AI_HOME 为同义别名）。
function resolveDefaultAiHomeDir(env = process.env) {
  return resolveAiHomeDir({ env });
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

/**
 * 某宿主能否服务该 Provider 在指定入口上的推理 —— 「谁能服务什么」的唯一判定。
 *
 * 声明源是 Go 生成的 `contracts/providers/manifest.json` 的 `relayHosts`（见
 * docs/plans/2026-10-17-inference-capability-registry.md）：**只有一份声明**，
 * Node 读 Go 的投影，因此不存在需要同步的两份名单。
 *
 * 为什么必须带 entryId：入口感知是能力的一部分。家族透传（codebuddy / workbuddy 四支）
 * 只挂在 chat completions，`/v1/messages` 上没有对应 Handler；只判「provider 支持」
 * 会让那条路径上的请求被转发到 Go 然后失败。
 *
 * 未声明 / 未支持的宿主一律返回 supported:false（保守侧），并把原因带回给调用方——
 * 禁止沉默缺失正是本能力位存在的理由。
 *
 * @param {string} host      'node' | 'go'
 * @param {string} provider
 * @param {string} entryId   入口 id（如 'gateway.anthropic.messages'）；空 = 只判 provider 级
 * @returns {{supported: boolean, channel: string, entries: string[], reason: string}}
 */
function resolveRelayHost(host, provider, entryId = '') {
  const hostName = String(host || '').trim().toLowerCase();
  const providerId = String(provider || '').trim().toLowerCase();
  const entry = String(entryId || '').trim();
  const unsupported = (reason) => ({ supported: false, channel: '', entries: [], reason });
  if (!hostName || !providerId) return unsupported('缺少宿主名或 provider');

  // 来源是 Go 生成的 manifest（`contracts/providers/manifest.json` 的 `relayHosts`），
  // 不是 `lib/providers/defs/*.js` 的描述符：宿主承接能力属于 Go 领域（谁有上游适配器），
  // 由 Go 声明一次、Node 读投影，因此不存在需要同步的两份名单。
  const definition = getProviderDefinition(providerId);
  const declared = definition && definition.relayHosts && definition.relayHosts[hostName];
  if (!declared) return unsupported(`${providerId} 未声明宿主 ${hostName} 的推理承接能力`);
  if (!declared.supported) return unsupported(declared.reason || `${providerId} 在 ${hostName} 上不支持推理`);

  // entries 为空 = 该通道覆盖全部推理入口（canonical 就是这样）；非空 = 只在列出的入口上挂载。
  //
  // 入口未知（entryId 为空）时对「限定入口」的通道保守返回不支持：不知道请求打哪个入口，
  // 就不能假设这个通道在它上面存在 —— 与「Go 服务不了」同一侧的保守处理。
  if (declared.entries.length > 0) {
    if (!entry) {
      return unsupported(`${providerId} 的 ${declared.channel} 通道只挂载在 ${declared.entries.join(',')}，入口未知时不能假设可用`);
    }
    if (!declared.entries.includes(entry)) {
      return unsupported(`${providerId} 的 ${declared.channel} 通道未挂载在入口 ${entry}`);
    }
  }
  return {
    supported: true,
    channel: declared.channel,
    entries: declared.entries,
    reason: ''
  };
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
  resolveRelayHost,
  listProviderDescriptorLoadErrors,
  formatProviderCapabilityLines,
  resolveDefaultAiHomeDir,
  resetProviderRegistryCache
};
