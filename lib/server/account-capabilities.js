'use strict';

const {
  SUPPORTED_SERVER_PROVIDERS,
  listEnabledProviders,
  normalizeModelId
} = require('./providers');
const { deriveAccountRuntimeStatus } = require('./account-runtime-state');

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
    if (id) target.add(id);
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
  const modelIds = new Set();
  addModels(modelIds, collectRegistryModels(state, provider));
  addModels(modelIds, collectCachedModels(state, provider));
  listProviderAccounts(state, provider).forEach((account) => {
    addModels(modelIds, account && account.availableModels);
  });
  if (provider === 'agy' && (listProviderAccounts(state, 'agy').length > 0 || (options && options.provider === 'agy'))) {
    addModels(modelIds, [
      'Gemini 3.5 Flash (Low)',
      'Gemini 3.5 Flash (Medium)',
      'Gemini 3.5 Flash (High)',
      'Gemini 3.1 Pro (Low)',
      'Gemini 3.1 Pro (High)',
      'Claude Sonnet 4.6 (Thinking)',
      'Claude Opus 4.6 (Thinking)',
      'GPT-OSS 120B (Medium)',
      'gemini-3.5-flash-low',
      'gemini-3.5-flash-medium',
      'gemini-3.5-flash-high',
      'gemini-3.1-pro-low',
      'gemini-3.1-pro-high',
      'claude-sonnet-4.6-thinking',
      'claude-opus-4.6-thinking',
      'gpt-oss-120b-medium'
    ]);
  }
  if (provider === 'codex') {
    addModels(modelIds, parseCsvModels(options && options.codexModels));
  }
  return Array.from(modelIds).sort();
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

function buildProviderCapability(state, options, provider, now = Date.now()) {
  const accounts = listProviderAccounts(state, provider);
  const availableAccounts = accounts.filter((account) => isSchedulableAccount(account, now));
  const modelIds = collectProviderModelIds(state, options, provider);
  return {
    provider,
    accounts,
    availableAccounts,
    accountCount: accounts.length,
    availableCount: availableAccounts.length,
    modelIds,
    modelSet: new Set(modelIds.map((id) => normalizeModelId(id)).filter(Boolean))
  };
}

function buildAccountCapabilityRegistry(state, options = {}) {
  const providers = {};
  let totalAccounts = 0;
  let totalAvailable = 0;
  SUPPORTED_SERVER_PROVIDERS.forEach((provider) => {
    const capability = buildProviderCapability(state, options, provider);
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
  const normalized = normalizeModelId(model);
  if (!normalized || !capability || !(capability.modelSet instanceof Set)) return false;
  return capability.modelSet.has(normalized);
}

function inferModelFamilyProvider(model) {
  const normalized = normalizeModelId(model);
  if (!normalized) return '';
  if (normalized.startsWith('agy') || normalized.startsWith('antigravity')) return 'agy';
  if (
    normalized.includes('3.5 flash') ||
    normalized.includes('3.5-flash') ||
    normalized.includes('3.1 pro') ||
    normalized.includes('3.1-pro') ||
    normalized.includes('sonnet 4.6') ||
    normalized.includes('sonnet-4.6') ||
    normalized.includes('opus 4.6') ||
    normalized.includes('opus-4.6') ||
    normalized.includes('gpt-oss') ||
    normalized.includes('gpt oss')
  ) {
    return 'agy';
  }
  if (normalized.startsWith('gemini')) return 'gemini';
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
  inferModelFamilyProvider,
  isSchedulableAccount,
  modelMatchesProvider,
  parseCsvModels
};
