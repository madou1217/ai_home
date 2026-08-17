'use strict';

// 该模块是现有 Node 运行时的兼容适配器。
// Provider 人工定义只允许出现在 core/providers/builtins.go，当前文件只读取生成合同并提供旧 API。
const manifestData = require('../contracts/providers/manifest.json');

// 旧调用方使用 camelCase 能力名；合同内部统一使用稳定的 snake_case 标识。
const CAPABILITY_ALIASES = Object.freeze({
  apiKeyAccount: 'api_key_account',
  modelCatalog: 'model_catalog',
  quotaUsage: 'quota_usage'
});

// deepFreeze 递归冻结纯数据对象，防止任意消费层修改全局 Provider 合同。
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach((child) => deepFreeze(child));
  return Object.freeze(value);
}

// cloneJson 为旧调用方返回防御性副本，合同中不允许出现函数或循环引用。
function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

// normalizeProviderId 统一 Provider 字符串身份。
function normalizeProviderId(providerRaw) {
  return String(providerRaw || '').trim().toLowerCase();
}

// normalizeCapabilityId 同时接受新合同标识和迁移期旧标识。
function normalizeCapabilityId(capabilityRaw) {
  const capability = String(capabilityRaw || '').trim();
  return CAPABILITY_ALIASES[capability] || capability;
}

// normalizePresentation 将生成合同的展示结构压平为旧 Node/Web API 形状。
function normalizePresentation(presentation = {}, fallbackId = '') {
  return {
    id: normalizeProviderId(presentation.id || fallbackId),
    label: String(presentation.label || '').trim(),
    short: String(presentation.short || '').trim(),
    terminalIcon: String(presentation.terminalIcon || '').trim(),
    terminalIconAsset: String(presentation.terminalIconAsset || '').trim(),
    accentVar: String(presentation.accentVar || '').trim(),
    softVar: String(presentation.softVar || '').trim(),
    tagColor: String(presentation.tagColor || '').trim()
  };
}

// normalizeDefinition 只做边界归一化，不补造任何 Provider 能力。
function normalizeDefinition(definition = {}) {
  const id = normalizeProviderId(definition.id);
  return deepFreeze({
    id,
    presentation: deepFreeze(normalizePresentation(definition.presentation, id)),
    gateway: String(definition.gateway || '').trim(),
    capabilities: deepFreeze((Array.isArray(definition.capabilities) ? definition.capabilities : [])
      .map((capability) => normalizeCapabilityId(capability))
      .filter(Boolean)),
    authOptions: deepFreeze(cloneJson(Array.isArray(definition.authOptions) ? definition.authOptions : [])),
    sessionSync: deepFreeze(cloneJson(definition.sessionSync || {})),
    clients: deepFreeze({
      cli: Boolean(definition.clients && definition.clients.cli),
      desktop: Boolean(definition.clients && definition.clients.desktop)
    }),
    cli: definition.cli ? deepFreeze(cloneJson(definition.cli)) : null,
    nativeBoundary: definition.nativeBoundary ? deepFreeze(cloneJson(definition.nativeBoundary)) : null
  });
}

const PROVIDER_SCHEMA_VERSION = Number(manifestData.schemaVersion || 0);
const PROVIDER_DEFINITIONS = deepFreeze((manifestData.providers || [])
  .map(normalizeDefinition)
  .filter((definition) => definition.id && definition.presentation.label));
const PROVIDER_IDS = deepFreeze(PROVIDER_DEFINITIONS.map((definition) => definition.id));
const PROVIDER_DEFINITIONS_BY_ID = deepFreeze(Object.fromEntries(
  PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition])
));

// PROVIDER_CATALOG 保留原先的扁平展示目录 API，避免本阶段扩大迁移范围。
const PROVIDER_CATALOG = deepFreeze(Object.fromEntries(
  PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition.presentation])
));
const CATALOG_FALLBACK = deepFreeze(normalizePresentation(manifestData.fallback || {}, 'codex'));
const DEPRECATED_GATEWAY_PROVIDERS = deepFreeze(PROVIDER_DEFINITIONS
  .filter((definition) => definition.gateway === 'deprecated')
  .map((definition) => definition.id));

// PROVIDER_CONTRACT 暴露只读合同元信息，供一致性测试和后续 Server API 使用。
const PROVIDER_CONTRACT = deepFreeze({
  schemaVersion: PROVIDER_SCHEMA_VERSION,
  generatedFrom: String(manifestData.generatedFrom || '').trim(),
  providers: PROVIDER_DEFINITIONS,
  fallback: CATALOG_FALLBACK
});

class ProviderCatalog {
  // 构造函数只接收纯领域定义，不依赖 Server、Client 或 Provider Adapter。
  constructor({ definitions, fallback }) {
    this.definitions = definitions;
    this.ids = deepFreeze(definitions.map((provider) => provider.id));
    this.definitionsById = deepFreeze(Object.fromEntries(
      definitions.map((definition) => [definition.id, definition])
    ));
    this.fallback = fallback;
    this.deprecatedGatewayProviders = deepFreeze(definitions
      .filter((definition) => definition.gateway === 'deprecated')
      .map((definition) => definition.id));
    this.capabilities = deepFreeze(Object.fromEntries(
      Object.keys(CAPABILITY_ALIASES).map((capability) => [capability, this.listByCapability(capability)])
    ));
    Object.freeze(this);
  }

  // normalize 只接受合同中真实存在的 Provider。
  normalize(providerRaw) {
    const provider = normalizeProviderId(providerRaw);
    return this.has(provider) ? provider : '';
  }

  // has 判断 Provider 身份是否已注册。
  has(providerRaw) {
    return Boolean(this.definitionsById[normalizeProviderId(providerRaw)]);
  }

  // get 返回兼容的展示元数据；未知 Provider 使用安全回退。
  get(providerRaw) {
    const definition = this.definitionsById[normalizeProviderId(providerRaw)];
    return definition ? definition.presentation : this.fallback;
  }

  // list 返回按产品顺序排列的定义切片副本。
  list() {
    return this.definitions.slice();
  }

  // listIds 返回稳定 Provider ID 列表副本。
  listIds() {
    return this.ids.slice();
  }

  // supports 只查询声明式能力，不调用具体实现。
  supports(providerRaw, capabilityRaw) {
    const definition = this.definitionsById[normalizeProviderId(providerRaw)];
    const capability = normalizeCapabilityId(capabilityRaw);
    return Boolean(definition && capability && definition.capabilities.includes(capability));
  }

  // listByCapability 按产品顺序筛选声明了能力的 Provider。
  listByCapability(capabilityRaw) {
    const capability = normalizeCapabilityId(capabilityRaw);
    if (!capability) return [];
    return this.definitions
      .filter((definition) => definition.capabilities.includes(capability))
      .map((definition) => definition.id);
  }
}

const providerCatalog = new ProviderCatalog({
  definitions: PROVIDER_DEFINITIONS,
  fallback: CATALOG_FALLBACK
});

// isKnownProvider 判断字符串是否为已注册 Provider。
function isKnownProvider(providerRaw) {
  return providerCatalog.has(providerRaw);
}

// getProviderMeta 返回兼容的展示元数据。
function getProviderMeta(providerRaw) {
  return providerCatalog.get(providerRaw);
}

// getProviderDefinition 返回完整只读定义，未知 Provider 返回 null。
function getProviderDefinition(providerRaw) {
  return PROVIDER_DEFINITIONS_BY_ID[normalizeProviderId(providerRaw)] || null;
}

// listProviderDefinitions 返回完整定义列表副本。
function listProviderDefinitions() {
  return PROVIDER_DEFINITIONS.slice();
}

// getProviderAuthOptions 返回 Client 可展示的认证选项副本。
function getProviderAuthOptions(providerRaw) {
  const definition = getProviderDefinition(providerRaw);
  return definition ? cloneJson(definition.authOptions) : [];
}

// getProviderCLIConfig 返回原生 CLI 声明副本。
function getProviderCLIConfig(providerRaw) {
  const definition = getProviderDefinition(providerRaw);
  return definition && definition.cli ? cloneJson(definition.cli) : null;
}

// getProviderClientSupport 返回 Provider 面向 Toolkit 的客户端形态合同。
function getProviderClientSupport(providerRaw) {
  const definition = getProviderDefinition(providerRaw);
  return definition ? { ...definition.clients } : { cli: false, desktop: false };
}

// getProviderNativeBoundary 返回原生能力边界副本。
function getProviderNativeBoundary(providerRaw) {
  const definition = getProviderDefinition(providerRaw);
  return definition && definition.nativeBoundary ? cloneJson(definition.nativeBoundary) : null;
}

// getProviderSessionSync 返回会话同步声明副本。
function getProviderSessionSync(providerRaw) {
  const definition = getProviderDefinition(providerRaw);
  return definition ? cloneJson(definition.sessionSync) : null;
}

// getProviderTerminalIcon 返回终端文本图标。
function getProviderTerminalIcon(providerRaw) {
  return getProviderMeta(providerRaw).terminalIcon || CATALOG_FALLBACK.terminalIcon;
}

// getProviderTerminalIconAsset 返回终端 profile 图标资产路径。
function getProviderTerminalIconAsset(providerRaw) {
  return getProviderMeta(providerRaw).terminalIconAsset || CATALOG_FALLBACK.terminalIconAsset;
}

// getProviderTerminalBadge 返回紧凑的终端 Provider 标识。
function getProviderTerminalBadge(providerRaw) {
  const meta = getProviderMeta(providerRaw);
  const icon = meta.terminalIcon || CATALOG_FALLBACK.terminalIcon;
  const short = meta.short || meta.label || meta.id || 'AI';
  return `${icon} ${short}`;
}

// listProviderIds 返回稳定 Provider ID 列表副本。
function listProviderIds() {
  return providerCatalog.listIds();
}

// providerSupports 查询 Provider 是否声明了指定能力。
function providerSupports(providerRaw, capability) {
  return providerCatalog.supports(providerRaw, capability);
}

// listProvidersByCapability 返回声明了指定能力的 Provider。
function listProvidersByCapability(capability) {
  return providerCatalog.listByCapability(capability);
}

module.exports = {
  ProviderCatalog,
  providerCatalog,
  PROVIDER_SCHEMA_VERSION,
  PROVIDER_CONTRACT,
  PROVIDER_DEFINITIONS,
  PROVIDER_IDS,
  PROVIDER_CATALOG,
  CATALOG_FALLBACK,
  DEPRECATED_GATEWAY_PROVIDERS,
  normalizeProviderId,
  isKnownProvider,
  getProviderMeta,
  getProviderDefinition,
  listProviderDefinitions,
  getProviderAuthOptions,
  getProviderCLIConfig,
  getProviderClientSupport,
  getProviderNativeBoundary,
  getProviderSessionSync,
  getProviderTerminalIcon,
  getProviderTerminalIconAsset,
  getProviderTerminalBadge,
  listProviderIds,
  providerSupports,
  listProvidersByCapability
};
