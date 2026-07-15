'use strict';

const {
  SUPPORTED_SERVER_PROVIDERS,
  listEnabledProviders,
  normalizeModelId
} = require('./providers');
const {
  isPublicCatalogModelId,
  listModelIdLookupKeys
} = require('./model-id');
const { deriveAccountRuntimeStatus } = require('./account-runtime-state');
const {
  buildModelCapabilityIndex,
  listProviderModelIds,
  listAvailableAccountRefsForModelProvider
} = require('./model-capability-index');

function parseCsvModels(value) {
  return String(value || '')
    .split(',')
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function addModels(target, models) {
  if (!(target instanceof Set)) return;
  (Array.isArray(models) ? models : []).forEach((model) => {
    const id = String(model || '').trim();
    if (isPublicCatalogModelId(id)) target.add(id);
  });
}

function listProviderAccounts(state, provider) {
  const accounts = state && state.accounts && state.accounts[provider];
  return Array.isArray(accounts) ? accounts : [];
}

function collectRegistryModels(state, provider) {
  const providerModels = state
    && state.modelRegistry
    && state.modelRegistry.providers
    && state.modelRegistry.providers[provider];
  return providerModels instanceof Set ? Array.from(providerModels) : [];
}

function collectCachedModels(state, provider) {
  const models = state
    && state.webUiModelsCache
    && state.webUiModelsCache.byProvider
    && state.webUiModelsCache.byProvider[provider];
  return Array.isArray(models) ? models : [];
}

function collectProviderModelIds(state, options, provider) {
  const index = buildModelCapabilityIndex(state, options || {});
  return listProviderModelIds(index, provider);
}

function hasUsableCredential(account) {
  return Boolean(String(account && account.accessToken || '').trim());
}

function isSchedulableAccount(account, now = Date.now()) {
  if (!account || !hasUsableCredential(account)) return false;
  if (now < Number(account.cooldownUntil || 0)) return false;
  if (String(account.schedulableStatus || '').trim() && account.schedulableStatus !== 'schedulable') {
    return false;
  }
  return deriveAccountRuntimeStatus(account, now).status === 'healthy';
}

function buildProviderCapability(state, options, provider, index, now = Date.now()) {
  const accounts = listProviderAccounts(state, provider);
  const availableAccounts = accounts.filter((account) => isSchedulableAccount(account, now));
  const modelIds = listProviderModelIds(index, provider);
  const modelSet = new Set();
  const availableAccountRefsByModel = {};
  modelIds.forEach((id) => {
    listModelIdLookupKeys(id).forEach((key) => modelSet.add(key));
    availableAccountRefsByModel[id] = listAvailableAccountRefsForModelProvider(index, id, provider, now);
  });
  return {
    provider,
    accounts,
    availableAccounts,
    accountCount: accounts.length,
    availableCount: availableAccounts.length,
    modelIds,
    modelSet,
    availableAccountRefsByModel
  };
}

function buildAccountCapabilityRegistry(state, options = {}) {
  const providers = {};
  let totalAccounts = 0;
  let totalAvailable = 0;
  const index = buildModelCapabilityIndex(state, options);
  SUPPORTED_SERVER_PROVIDERS.forEach((provider) => {
    const capability = buildProviderCapability(state, options, provider, index);
    providers[provider] = capability;
    totalAccounts += capability.accountCount;
    totalAvailable += capability.availableCount;
  });
  return {
    providers,
    totalAccounts,
    totalAvailable,
    enabledProviders: listEnabledProviders(options && options.provider)
  };
}

function modelMatchesProvider(capability, model) {
  if (!capability || !(capability.modelSet instanceof Set)) return false;
  return listModelIdLookupKeys(model).some((key) => capability.modelSet.has(key));
}

function countAvailableAccountsForModel(capability, model) {
  if (!capability || !capability.availableAccountRefsByModel) return 0;
  const matchedModel = (Array.isArray(capability.modelIds) ? capability.modelIds : [])
    .find((id) => listModelIdLookupKeys(model).some((key) => listModelIdLookupKeys(id).includes(key)));
  if (!matchedModel) return 0;
  const accountRefs = capability.availableAccountRefsByModel[matchedModel];
  return Array.isArray(accountRefs) ? accountRefs.length : 0;
}

function inferModelFamilyProvider(model) {
  const normalized = normalizeModelId(model);
  if (!normalized) return '';
  if (normalized.startsWith('agy') || normalized.startsWith('antigravity')) {
    return 'agy';
  }
  // gemini provider(非 agy）已废弃；gemini-* 模型由 agy(antigravity）服务，故归到 agy。
  if (normalized.startsWith('gemini')) return 'agy';
  if (normalized.startsWith('claude') || normalized.startsWith('anthropic')) return 'claude';
  if (
    normalized.startsWith('gpt')
    || normalized.startsWith('o1')
    || normalized.startsWith('o3')
    || normalized.startsWith('o4')
  ) {
    return 'codex';
  }
  return '';
}

module.exports = {
  buildAccountCapabilityRegistry,
  collectProviderModelIds,
  countAvailableAccountsForModel,
  inferModelFamilyProvider,
  isSchedulableAccount,
  modelMatchesProvider,
  parseCsvModels
};
