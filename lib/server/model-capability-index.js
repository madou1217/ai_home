'use strict';

const { SUPPORTED_SERVER_PROVIDERS, listEnabledProviders } = require('./providers');
const {
  isRealProviderModelId,
  listModelIdLookupKeys
} = require('./model-id');
const { deriveAccountRuntimeStatus, getAccountModelCooldownUntil } = require('./account-runtime-state');
const {
  isAccountModelEnabled,
  isModelEnabled,
  listManualModelSettings
} = require('./model-catalog-settings-store');
const {
  isTrustedAgyUsageSnapshot
} = require('./agy-usage-snapshot');
const { listAccountModelCacheRefs } = require('./provider-model-discovery');

function createEmptyModelCapabilityIndex() {
  return {
    accountModels: new Map(),
    providerModels: new Map(),
    modelProviders: new Map(),
    upstreamModelByAccount: new Map(),
    accountByRef: new Map(),
    modelLookup: new Map()
  };
}

function normalizeProvider(provider) {
  const value = String(provider || '').trim().toLowerCase();
  return SUPPORTED_SERVER_PROVIDERS.includes(value) ? value : '';
}

function getAccountRef(provider, account) {
  return listAccountModelCacheRefs(provider, account)[0] || '';
}

function ensureMapValue(map, key, createValue) {
  if (!map.has(key)) map.set(key, createValue());
  return map.get(key);
}

function addLookupKeys(index, modelId) {
  listModelIdLookupKeys(modelId).forEach((key) => {
    if (key && !index.modelLookup.has(key)) index.modelLookup.set(key, modelId);
  });
}

function hasSameModelLookupKey(left, right) {
  const leftKeys = new Set(listModelIdLookupKeys(left));
  return listModelIdLookupKeys(right).some((key) => leftKeys.has(key));
}

function findAgyQuotaModel(account, modelId) {
  const snapshot = account && account.usageSnapshot;
  if (!isTrustedAgyUsageSnapshot(snapshot)) return null;
  return snapshot.models.find((model) => hasSameModelLookupKey(model && model.model, modelId)) || null;
}

function isAccountModelAllowedByQuota(provider, account, modelId) {
  if (provider !== 'agy') return true;
  const snapshot = account && account.usageSnapshot;
  if (!isTrustedAgyUsageSnapshot(snapshot)) return true;
  const quotaModel = findAgyQuotaModel(account, modelId);
  if (!quotaModel) return false;
  return Number(quotaModel.remainingPct) > 0;
}

function addProviderModel(index, provider, modelId, settings = null) {
  const normalizedProvider = normalizeProvider(provider);
  const id = String(modelId || '').trim();
  if (!normalizedProvider || !isRealProviderModelId(id)) return;
  if (!isModelEnabled(settings, id)) return;
  ensureMapValue(index.providerModels, normalizedProvider, () => new Set()).add(id);
  addLookupKeys(index, id);
}

function addAccountModel(index, provider, account, modelId, upstreamModelId = '', settings = null) {
  const normalizedProvider = normalizeProvider(provider);
  const accountRef = getAccountRef(normalizedProvider, account);
  const id = String(modelId || '').trim();
  if (!normalizedProvider || !accountRef || !isRealProviderModelId(id)) return;
  if (!isAccountModelAllowedByQuota(normalizedProvider, account, id)) return;
  if (!isAccountModelEnabled(settings, {
    id,
    provider: normalizedProvider,
    accountRef
  })) return;

  index.accountByRef.set(accountRef, account);
  ensureMapValue(index.accountModels, accountRef, () => new Set()).add(id);
  addProviderModel(index, normalizedProvider, id, settings);
  const providerMap = ensureMapValue(index.modelProviders, id, () => new Map());
  ensureMapValue(providerMap, normalizedProvider, () => new Set()).add(accountRef);
  if (upstreamModelId && upstreamModelId !== id) {
    ensureMapValue(index.upstreamModelByAccount, accountRef, () => new Map()).set(id, upstreamModelId);
  }
}

function collectDescriptorModels(account) {
  const descriptors = []
    .concat(Array.isArray(account && account.codeAssistModelDescriptors) ? account.codeAssistModelDescriptors : [])
    .concat(Array.isArray(account && account.availableModelDescriptors) ? account.availableModelDescriptors : [])
    .concat(Array.isArray(account && account.modelDescriptors) ? account.modelDescriptors : []);
  return descriptors
    .map((descriptor) => ({
      modelId: String(descriptor && (descriptor.id || descriptor.modelId) || '').trim(),
      upstreamModelId: String(descriptor && (descriptor.wireId || descriptor.upstreamModel || descriptor.upstreamModelId) || '').trim()
    }))
    .filter((item) => item.modelId);
}

function addAccountModelsFromList(index, provider, account, models, settings = null) {
  (Array.isArray(models) ? models : []).forEach((modelId) => {
    addAccountModel(index, provider, account, modelId, '', settings);
  });
}

function addAccountDescriptorModels(index, provider, account, settings = null) {
  collectDescriptorModels(account).forEach((item) => {
    addAccountModel(index, provider, account, item.modelId, item.upstreamModelId, settings);
  });
}

function readByAccountModels(state, provider, account) {
  const accountRefs = listAccountModelCacheRefs(provider, account);
  const sources = [
    state && state.webUiModelsCache && state.webUiModelsCache.byAccount,
    state && state.modelsCache && state.modelsCache.byAccount
  ];
  const out = [];
  sources.forEach((source) => {
    if (!source || typeof source !== 'object') return;
    accountRefs.forEach((accountRef) => {
      const models = source[accountRef];
      if (Array.isArray(models)) out.push(...models);
    });
  });
  return out;
}

function manualModelSettingMatchesAccount(record, provider, account, accountRef) {
  if (!record || record.provider !== provider) return false;
  return Boolean(record.accountRef && record.accountRef === accountRef);
}

function readProviderAccounts(state, provider) {
  const accounts = state && state.accounts && state.accounts[provider];
  return Array.isArray(accounts) ? accounts : [];
}

function addProviderLevelModels(index, state, provider, options = {}) {
  const settings = state && state.modelCatalogSettings || null;
  const sources = [
    state && state.webUiModelsCache && state.webUiModelsCache.byProvider,
    state && state.modelsCache && state.modelsCache.byProvider
  ];
  sources.forEach((source) => {
    const models = source && source[provider];
    (Array.isArray(models) ? models : []).forEach((modelId) => addProviderModel(index, provider, modelId, settings));
  });
  const registryModels = state
    && state.modelRegistry
    && state.modelRegistry.providers
    && state.modelRegistry.providers[provider];
  if (registryModels instanceof Set) {
    registryModels.forEach((modelId) => addProviderModel(index, provider, modelId, settings));
  }
  if (provider === 'codex') {
    String(options && options.codexModels || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((modelId) => addProviderModel(index, provider, modelId, settings));
  }
}

function buildModelCapabilityIndex(state, options = {}) {
  const index = createEmptyModelCapabilityIndex();
  const settings = state && state.modelCatalogSettings || null;
  SUPPORTED_SERVER_PROVIDERS.forEach((provider) => {
    addProviderLevelModels(index, state, provider, options);
    const manualModels = listManualModelSettings(settings, {
      providerMode: options && options.provider,
      enabledOnly: true
    }).filter((record) => !record.provider || record.provider === provider);
    readProviderAccounts(state, provider).forEach((account) => {
      const accountRef = getAccountRef(provider, account);
      if (!accountRef) return;
      index.accountByRef.set(accountRef, account);
      addAccountModelsFromList(index, provider, account, account && account.availableModels, settings);
      addAccountModelsFromList(index, provider, account, readByAccountModels(state, provider, account), settings);
      addAccountDescriptorModels(index, provider, account, settings);
      addAccountModelsFromList(
        index,
        provider,
        account,
        manualModels
          .filter((record) => manualModelSettingMatchesAccount(record, provider, account, accountRef))
          .map((record) => record.id),
        settings
      );
      if (provider === 'codex' && options && options.codexModels) {
        addAccountModelsFromList(index, provider, account, String(options.codexModels).split(','), settings);
      }
    });
  });
  return index;
}

function resolveRealModelId(index, modelId) {
  const keys = listModelIdLookupKeys(modelId);
  for (const key of keys) {
    if (index && index.modelLookup && index.modelLookup.has(key)) return index.modelLookup.get(key);
  }
  return '';
}

function listProviderModelIds(index, provider) {
  const normalizedProvider = normalizeProvider(provider);
  const models = normalizedProvider && index && index.providerModels
    ? index.providerModels.get(normalizedProvider)
    : null;
  return Array.from(models instanceof Set ? models : []).sort();
}

function isAccountRoutable(account, now = Date.now()) {
  if (!account || !String(account.accessToken || '').trim()) return false;
  if (now < Number(account.cooldownUntil || 0)) return false;
  if (String(account.schedulableStatus || '').trim() && account.schedulableStatus !== 'schedulable') return false;
  const runtime = deriveAccountRuntimeStatus(account, now);
  if (runtime.status !== 'healthy') return false;
  if (!account.apiKeyMode) {
    const pct = account.remainingPct;
    if (pct != null && pct !== '' && Number.isFinite(Number(pct)) && Number(pct) <= 0) return false;
  }
  return true;
}

function listAccountRefsForModelProvider(index, modelId, provider) {
  const realModelId = resolveRealModelId(index, modelId) || String(modelId || '').trim();
  const providerMap = index && index.modelProviders ? index.modelProviders.get(realModelId) : null;
  const accountRefs = providerMap instanceof Map ? providerMap.get(normalizeProvider(provider)) : null;
  return Array.from(accountRefs instanceof Set ? accountRefs : []).sort();
}

function listAvailableAccountRefsForModelProvider(index, modelId, provider, now = Date.now()) {
  return listAccountRefsForModelProvider(index, modelId, provider)
    .filter((accountRef) => isAccountRoutable(index.accountByRef.get(accountRef), now));
}

function modelHasAvailableProvider(index, modelId, provider, now = Date.now()) {
  return listAvailableAccountRefsForModelProvider(index, modelId, provider, now).length > 0;
}

// Routing-time variant: like the "available" check above, but additionally
// excludes accounts whose per-(account, model) cooldown is active for THIS
// model. Used by the alias-fallback preflight so that when every account for a
// model is rate-limited, routing falls through to the next alias candidate
// (e.g. claude-* -> claude-opus exhausted, fall back to gemini-3.5-flash).
// Catalog/visibility validation must NOT use this (a momentarily-cooled target
// is still a valid alias), so it is a separate function.
function listRoutableAccountRefsForModelProvider(index, modelId, provider, now = Date.now()) {
  const realModelId = resolveRealModelId(index, modelId) || String(modelId || '').trim();
  return listAccountRefsForModelProvider(index, modelId, provider)
    .filter((accountRef) => {
      const account = index.accountByRef.get(accountRef);
      if (!isAccountRoutable(account, now)) return false;
      if (getAccountModelCooldownUntil(account, realModelId, now) > now) return false;
      return true;
    });
}

function modelHasRoutableProvider(index, modelId, provider, now = Date.now()) {
  return listRoutableAccountRefsForModelProvider(index, modelId, provider, now).length > 0;
}

// Summarize WHY the accounts backing a (model, provider) are not routable right
// now, e.g. "3 account(s), 3 unavailable (transient_network: fetch failed x2;
// rate_limited x1)". Used to enrich alias-fallback 503 diagnostics so the bare
// "all accounts cooling down" label carries the real per-account reason instead
// of leaving the caller guessing (or misreading an unrelated catalog-scan 403).
function summarizeModelProviderCooldown(index, modelId, provider, now = Date.now()) {
  const realModelId = resolveRealModelId(index, modelId) || String(modelId || '').trim();
  const refs = listAccountRefsForModelProvider(index, modelId, provider);
  const counts = new Map();
  let blocked = 0;
  for (const accountRef of refs) {
    const account = index.accountByRef.get(accountRef);
    if (!account) continue;
    const modelCooled = getAccountModelCooldownUntil(account, realModelId, now) > now;
    if (isAccountRoutable(account, now) && !modelCooled) continue;
    blocked += 1;
    const runtime = deriveAccountRuntimeStatus(account, now);
    let label = String(runtime.status || '').trim();
    if (modelCooled && (!label || label === 'healthy')) label = 'model_cooldown';
    if (!label || label === 'healthy') label = 'cooling_down';
    const reason = String(runtime.reason || account.lastError || '').trim();
    const key = reason ? `${label}: ${reason.slice(0, 80)}` : label;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (blocked === 0) return '';
  const parts = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, count]) => (count > 1 ? `${key} x${count}` : key));
  return `${provider}: ${refs.length} account(s), ${blocked} unavailable (${parts.join('; ')})`;
}

function modelHasAvailableAccount(index, modelId, providerMode = 'auto', now = Date.now()) {
  const providers = listEnabledProviders(providerMode);
  return providers.some((provider) => modelHasAvailableProvider(index, modelId, provider, now));
}

module.exports = {
  addAccountModel,
  buildModelCapabilityIndex,
  createEmptyModelCapabilityIndex,
  getAccountRef,
  isAccountRoutable,
  listAccountRefsForModelProvider,
  listAvailableAccountRefsForModelProvider,
  listRoutableAccountRefsForModelProvider,
  listProviderModelIds,
  modelHasAvailableAccount,
  modelHasAvailableProvider,
  modelHasRoutableProvider,
  summarizeModelProviderCooldown,
  resolveRealModelId
};
