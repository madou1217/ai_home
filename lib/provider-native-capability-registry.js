'use strict';

const { listProviderDefinitions } = require('./provider-catalog');

// cloneJson 为调用方返回可修改副本，注册表内部始终保持只读。
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

// deepFreeze 递归冻结生成合同中的原生能力投影。
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach((child) => deepFreeze(child));
  return Object.freeze(value);
}

// PROVIDER_NATIVE_CAPABILITIES 只包含已确认原生边界的 Provider；未声明不等于自动支持。
const PROVIDER_NATIVE_CAPABILITIES = deepFreeze(Object.fromEntries(
  listProviderDefinitions()
    .filter((definition) => definition.nativeBoundary)
    .map((definition) => [definition.id, {
      provider: definition.id,
      ...cloneJson(definition.nativeBoundary)
    }])
));

// normalizeProvider 统一 Provider 字符串身份。
function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase();
}

// getProviderNativeCapability 返回单个原生能力边界的防御性副本。
function getProviderNativeCapability(provider) {
  const capability = PROVIDER_NATIVE_CAPABILITIES[normalizeProvider(provider)];
  return capability ? cloneJson(capability) : null;
}

// listProviderNativeCapabilities 按 Provider ID 排序返回所有已确认边界。
function listProviderNativeCapabilities() {
  return Object.keys(PROVIDER_NATIVE_CAPABILITIES)
    .sort()
    .map((provider) => getProviderNativeCapability(provider));
}

// buildProviderNativeCapabilityMap 为指定 Provider 集合构建安全的键值映射。
function buildProviderNativeCapabilityMap(providers) {
  return (Array.isArray(providers) ? providers : [])
    .reduce((acc, provider) => {
      const key = normalizeProvider(provider);
      const capability = getProviderNativeCapability(key);
      if (key && capability) acc[key] = capability;
      return acc;
    }, {});
}

module.exports = {
  PROVIDER_NATIVE_CAPABILITIES,
  buildProviderNativeCapabilityMap,
  getProviderNativeCapability,
  listProviderNativeCapabilities,
  __private: {
    normalizeProvider
  }
};
