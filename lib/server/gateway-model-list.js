'use strict';

const { listEnabledProviders } = require('./providers');
const {
  normalizeAliasRecord
} = require('./model-alias-store');
const {
  applyModelCatalogSettingsToEntries,
  isAccountModelEnabled,
  isModelEnabled,
  normalizeGatewayEntry
} = require('./model-catalog-settings-store');
const { buildModelCapabilityIndex, listProviderModelIds } = require('./model-capability-index');
const { aliasIsVisible, validateAliasRecordForSave } = require('./model-alias-validation');
const { listWildcardAliasModels } = require('./wildcard-alias-expansion');
const { imageModelBelongsToProvider } = require('./image-generation-model-specs');

function normalizeModelEntry(entry) {
  return normalizeGatewayEntry(entry);
}

function buildAliasModelEntries(aliases, context = {}) {
  const modelCapabilityIndex = context.modelCapabilityIndex
    || buildModelCapabilityIndex(context.state || {}, context.options || {});
  const visibilityContext = { ...context, modelCapabilityIndex, aliases };
  const entries = [];
  (Array.isArray(aliases) ? aliases : [])
    .map((item) => normalizeAliasRecord(item))
    .forEach((alias) => {
      const provider = alias.provider === 'all' ? '' : alias.provider;
      if (!String(alias.alias || '').endsWith('*')) {
        if (!aliasIsVisible(alias, visibilityContext)) return;
        entries.push({ id: alias.alias, origin: alias.target, provider, source: 'alias' });
        return;
      }
      // 通配别名本身不是可发送的模型名（客户端不能发 `claude-*`），列出它能代替的常见型号：
      // 每个 family 最新 3 代且发布不超过一年（见 wildcard-alias-expansion）。目标得真实可路由，
      // 否则展开出来的名字一个都打不通。
      if (alias.enabled === false || !validateAliasRecordForSave(alias, visibilityContext).ok) return;
      listWildcardAliasModels(alias.alias).forEach((id) => {
        entries.push({ id, origin: alias.target, provider, source: 'alias', aliasPattern: alias.alias });
      });
    });
  return entries;
}

function buildLocalModelEntries(state, options = {}, modelCapabilityIndex = null, listOptions = {}) {
  // 能力索引是 O(账号 × 模型) 的构建：按 provider 逐个重建会让 16 个 provider 变成 16 次
  // 全量扫描（翻译页/模型页一次请求就要 1~2 秒）。这里只建一次，再按 provider 取列表。
  const index = modelCapabilityIndex || buildModelCapabilityIndex(state, options);
  const includeImageModels = listOptions && listOptions.includeImageModels === true;
  const entries = [];
  listEnabledProviders(options && options.provider).forEach((provider) => {
    listProviderModelIds(index, provider).forEach((id) => {
      // 原生图像模型是专用生图能力：聊天口径的列表（翻译页、WebUI 模型页）不放它。
      // 对外的 /v1/models 必须放（includeImageModels）：下游 AIH / 客户端只能从这里发现
      // 本网关能生图的模型，藏起来就等于中转链路永远用不到它（条目带 aih_modalities，
      // 聊天客户端可按 output 模态自行过滤）。
      if (!includeImageModels && imageModelBelongsToProvider(provider, id)) return;
      entries.push({ id, provider, source: 'capability' });
    });
  });
  return entries;
}

function mergeGatewayModelEntries(entries, aliases, context = {}) {
  const merged = new Map();
  const settings = context.modelCatalogSettings
    || context.state && context.state.modelCatalogSettings
    || null;

  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const normalized = normalizeModelEntry(entry);
    if (!normalized) return;
    if (normalized.accountRef) {
      if (!isAccountModelEnabled(settings, normalized)) return;
    } else if (!isModelEnabled(settings, normalized.id, normalized.provider)) {
      return;
    }
    if (!merged.has(normalized.id)) merged.set(normalized.id, normalized);
  });

  buildAliasModelEntries(aliases, context).forEach((entry) => {
    if (!isModelEnabled(settings, entry.id)) return;
    if (!merged.has(entry.id)) merged.set(entry.id, entry);
  });

  return applyModelCatalogSettingsToEntries(Array.from(merged.values()), settings, {
    providerMode: context.options && context.options.provider
  });
}

function buildGatewayModelEntries(state, options = {}, modelCapabilityIndex = null, listOptions = {}) {
  return buildLocalModelEntries(state, options, modelCapabilityIndex, listOptions);
}

module.exports = {
  buildAliasModelEntries,
  buildGatewayModelEntries,
  mergeGatewayModelEntries
};
