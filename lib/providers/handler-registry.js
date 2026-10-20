'use strict';

// Provider handler 注册表 —— 描述符只声明 handler id，实现由宿主组合根注册。
//
// 为什么需要它：
//   * `provider.descriptor` 是**数据**，插件通过 host RPC 只能返回 JSON；
//     探针/发现这类实现不能跟着描述符走，必须引用宿主已注册的 handler；
//   * 描述符里出现一个解析不到的 handler 属于配置错误，必须 fail closed，
//     不能静默降级成「没有模型发现 / 没有额度」。
//
// 与 `lib/server/model-discovery/handler-registry.js` 的关系：
//   * 后者是模型发现领域的实现表；这里提供统一解析入口，优先查 provider 注册表，
//     再回落到模型发现注册表（既有 builtin defs 已声明 generic-models-probe 等 id）。
//   * 不复制注册项，也不在这里维护 provider 名单。

const handlers = new Map();

function normalizeHandlerId(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function registerProviderHandler(id, factory, options = {}) {
  const key = normalizeHandlerId(id);
  if (!key) throw new Error('provider_handler_id_required');
  if (typeof factory !== 'function') throw new Error('provider_handler_factory_required');
  if (handlers.has(key)) {
    const error = new Error(`provider_handler_duplicate:${key}`);
    error.code = 'provider_handler_duplicate';
    throw error;
  }
  handlers.set(key, {
    id: key,
    factory,
    kind: normalizeHandlerId(options.kind) || 'provider',
    origin: normalizeHandlerId(options.origin) || 'builtin'
  });
  return key;
}

function registerProviderHandlers(entries, options = {}) {
  const registered = [];
  for (const [id, factory] of Object.entries(entries && typeof entries === 'object' ? entries : {})) {
    registered.push(registerProviderHandler(id, factory, options));
  }
  return registered;
}

function getProviderHandler(id) {
  const key = normalizeHandlerId(id);
  if (!key) return null;
  const local = handlers.get(key);
  if (local) return local.factory;
  // 既有模型发现 handler 仍由原注册表持有；统一解析时回落到它，避免两套 id 分裂。
  try {
    const { getModelDiscoveryHandler } = require('../server/model-discovery/handler-registry');
    return getModelDiscoveryHandler(key);
  } catch (_error) {
    return null;
  }
}

function hasProviderHandler(id) {
  return Boolean(getProviderHandler(id));
}

function listProviderHandlers() {
  const ids = new Set(handlers.keys());
  try {
    const { listModelDiscoveryHandlers } = require('../server/model-discovery/handler-registry');
    for (const id of listModelDiscoveryHandlers()) ids.add(id);
  } catch (_error) {}
  return [...ids].sort();
}

function resetProviderHandlers() {
  handlers.clear();
}

function providerDescriptorHandlerRefs(descriptor) {
  const refs = [];
  const capabilities = descriptor && descriptor.capabilities && typeof descriptor.capabilities === 'object'
    ? descriptor.capabilities
    : {};
  for (const capabilityName of ['models', 'quota']) {
    const capability = capabilities[capabilityName];
    const strategies = capability && Array.isArray(capability.strategies) ? capability.strategies : [];
    for (const strategy of strategies) {
      const handler = normalizeHandlerId(strategy && strategy.handler);
      if (handler) {
        refs.push({
          capability: capabilityName,
          strategyId: normalizeHandlerId(strategy.id),
          handler
        });
      }
    }
  }
  return refs;
}

function listMissingProviderHandlers(descriptor, resolve = getProviderHandler) {
  return providerDescriptorHandlerRefs(descriptor)
    .filter((ref) => typeof resolve(ref.handler) !== 'function')
    .map((ref) => `${ref.capability}:${ref.strategyId || '(unnamed)'}→${ref.handler}`);
}

module.exports = {
  registerProviderHandler,
  registerProviderHandlers,
  getProviderHandler,
  hasProviderHandler,
  listProviderHandlers,
  resetProviderHandlers,
  providerDescriptorHandlerRefs,
  listMissingProviderHandlers,
  __private: { normalizeHandlerId }
};
