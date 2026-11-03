'use strict';

const { isPublicCatalogModelId } = require('./model-id');
const { isAgyCliModelId, orderAgyModelIds } = require('../runtime/agy-model-names');

const PROVIDER_DEFAULT_MODELS = Object.freeze({});

// 每 provider 的「默认模型」声明（唯一一张表）：
//   snapshot  是否把**账号额度快照**里的模型目录也算作候选来源
//   accepts   候选 id 是否**能直接交给该 provider 的 CLI**（不满足就不当选，避免传下去被 CLI 拒绝）
//   prefer    候选排序（可选）
// 未声明的 provider 保持既有行为（只用模型缓存 / 注册表）。
const PROVIDER_MODEL_DEFAULTS = Object.freeze({
  agy: Object.freeze({
    snapshot: true,
    accepts: (id) => isAgyCliModelId(id),
    prefer: (ids) => orderAgyModelIds(ids)
  })
});

function providerModelDefaults(provider) {
  return PROVIDER_MODEL_DEFAULTS[provider] || null;
}

function acceptsModelId(provider, id) {
  const declaration = providerModelDefaults(provider);
  return declaration && typeof declaration.accepts === 'function' ? declaration.accepts(id) === true : true;
}

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function addModels(out, models) {
  (Array.isArray(models) ? models : []).forEach((model) => {
    const id = String(model || '').trim();
    if (isPublicCatalogModelId(id) && !out.includes(id)) out.push(id);
  });
}

function addRegistryModels(out, state, provider) {
  const registryModels = state
    && state.modelRegistry
    && state.modelRegistry.providers
    && state.modelRegistry.providers[provider];
  if (!(registryModels instanceof Set)) return;
  addModels(out, Array.from(registryModels));
}

// 账号额度快照自带的模型目录（provider 采集面给的权威清单）。provider 声明了可接受性过滤时，
// 只收「能交给 CLI」的 id —— 这样默认模型永远不会是 CLI 拒绝的那一类。
function addUsageSnapshotModels(out, state, provider, accountRef) {
  const declaration = providerModelDefaults(provider);
  if (!declaration || declaration.snapshot !== true) return;
  const accounts = state && state.accounts && state.accounts[provider];
  if (!Array.isArray(accounts) || accounts.length === 0) return;
  const requested = String(accountRef || '').trim();
  const account = (requested && accounts.find((item) => String(item && item.accountRef || '') === requested))
    || accounts[0];
  const models = account && account.usageSnapshot && account.usageSnapshot.models;
  if (!Array.isArray(models)) return;
  addModels(out, models
    .map((entry) => entry && entry.model)
    .filter((id) => acceptsModelId(provider, id)));
}

function collectProviderDefaultCandidates(providerRaw, source = {}) {
  const provider = normalizeProvider(providerRaw);
  const state = source && source.state && typeof source.state === 'object' ? source.state : {};
  const out = [];

  addModels(out, state && state.webUiModelsCache && state.webUiModelsCache.byProvider && state.webUiModelsCache.byProvider[provider]);
  addRegistryModels(out, state, provider);
  addUsageSnapshotModels(out, state, provider, source.accountRef);
  return out;
}

function resolveProviderDefaultModel(provider, fallback = '', source = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const candidates = collectProviderDefaultCandidates(provider, source);
  const declaration = providerModelDefaults(normalizedProvider);
  const ordered = declaration && typeof declaration.prefer === 'function'
    ? declaration.prefer(candidates)
    : candidates;
  return (Array.isArray(ordered) && ordered[0]) || String(fallback || '').trim();
}

module.exports = {
  PROVIDER_DEFAULT_MODELS,
  PROVIDER_MODEL_DEFAULTS,
  collectProviderDefaultCandidates,
  resolveProviderDefaultModel
};
