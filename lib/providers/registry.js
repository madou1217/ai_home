'use strict';

// Provider 注册表：**只做索引**，不持有任何 provider 名单。
//
//   * 每个 provider 由自己的描述符（`lib/providers/defs/<id>.js`）声明能力；
//   * 注册表建立 provider → 能力 与 **能力 → providers（倒排）** 两张索引；
//   * 消费方问能力（`listProviders('quota')` / `getCapability(id, 'quota')`），
//     因此新增 provider 不会在消费侧留下需要同步的名单。
//
// 冲突策略：同一 provider 重复注册时，内置优先；外部描述符不得覆盖内置（记为可观察错误）。

const { descriptorError, validateProviderDescriptor } = require('./contract');

const CAPABILITY_PRIORITY = Object.freeze({ builtin: 0, external: 1 });

function normalizeId(value) {
  return String(value === undefined || value === null ? '' : value).trim().toLowerCase();
}

/** 策略排序：不依赖本机客户端的（更稳、可在服务器上跑）优先，组内保持声明顺序。 */
function orderQuotaStrategies(strategies) {
  const stable = [];
  const dependent = [];
  for (const strategy of strategies) {
    (strategy.clientDependent ? dependent : stable).push(strategy);
  }
  return [...stable, ...dependent];
}

function createProviderRegistry(options = {}) {
  const byId = new Map();
  const loadErrors = [];
  const capabilityIndex = new Map();

  function indexCapabilities(entry) {
    for (const capability of Object.keys(entry.descriptor.capabilities)) {
      if (!capabilityIndex.has(capability)) capabilityIndex.set(capability, new Set());
      capabilityIndex.get(capability).add(entry.descriptor.id);
    }
  }

  function register(input, registerOptions = {}) {
    const descriptor = validateProviderDescriptor(input);
    const origin = registerOptions.origin === 'external' ? 'external' : 'builtin';
    const current = byId.get(descriptor.id);
    if (current) {
      const incomingWins = CAPABILITY_PRIORITY[origin] < CAPABILITY_PRIORITY[current.origin];
      if (!incomingWins) {
        throw descriptorError('provider_descriptor_conflict', `${descriptor.id}:${origin}`);
      }
      byId.delete(descriptor.id);
      for (const providers of capabilityIndex.values()) providers.delete(descriptor.id);
    }
    const entry = Object.freeze({ descriptor, origin });
    byId.set(descriptor.id, entry);
    indexCapabilities(entry);
    return descriptor;
  }

  function recordLoadError(error) {
    const code = String(error && error.code || 'provider_descriptor_load_failed');
    const rawDetail = String(error && error.detail || '').trim();
    const message = String(error && error.message || '').trim();
    const normalized = {
      code,
      detail: (rawDetail || (message && message !== code ? message : '')).slice(0, 240),
      target: String(error && error.target || '').slice(0, 240)
    };
    loadErrors.push(Object.freeze(normalized));
    return normalized;
  }

  function get(id) {
    const entry = byId.get(normalizeId(id));
    return entry ? entry.descriptor : null;
  }

  function getCapability(id, capability) {
    const descriptor = get(id);
    if (!descriptor) return null;
    return descriptor.capabilities[String(capability || '').trim()] || null;
  }

  function has(id) {
    return byId.has(normalizeId(id));
  }

  function listIds() {
    return [...byId.keys()].sort();
  }

  function listCapabilities(id) {
    const descriptor = get(id);
    return descriptor ? Object.keys(descriptor.capabilities).sort() : [];
  }

  function supports(id, capability) {
    return Boolean(getCapability(id, capability));
  }

  /** 倒排索引：能力 → 声明了该能力的 provider（排序稳定，便于断言与展示）。 */
  function listProviders(capability) {
    const providers = capabilityIndex.get(String(capability || '').trim());
    return providers ? [...providers].sort() : [];
  }

  function listCapabilityIndex() {
    const index = {};
    for (const capability of [...capabilityIndex.keys()].sort()) {
      index[capability] = listProviders(capability);
    }
    return index;
  }

  /** 额度策略链（默认最稳优先）；provider 无额度能力时返回 []。 */
  function listQuotaStrategies(id) {
    const quota = getCapability(id, 'quota');
    if (!quota || quota.supported !== true) return [];
    return orderQuotaStrategies(quota.strategies);
  }

  function resolveQuotaStrategy(id, strategyId) {
    const strategies = listQuotaStrategies(id);
    if (!strategyId) return strategies[0] || null;
    return strategies.find((strategy) => strategy.id === strategyId) || null;
  }

  for (const descriptor of (Array.isArray(options.descriptors) ? options.descriptors : [])) {
    register(descriptor, { origin: descriptor && descriptor.origin });
  }

  return {
    register,
    recordLoadError,
    get,
    getCapability,
    has,
    listIds,
    listCapabilities,
    supports,
    listProviders,
    listCapabilityIndex,
    listQuotaStrategies,
    resolveQuotaStrategy,
    listLoadErrors: () => [...loadErrors]
  };
}

module.exports = {
  createProviderRegistry,
  orderQuotaStrategies,
  __private: { normalizeId }
};
