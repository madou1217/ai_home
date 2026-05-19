'use strict';

const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');

const DEFAULT_PROVIDER_MODELS = {
  codex: ['gpt-5.4'],
  gemini: ['gemini-2.5-pro'],
  claude: ['claude-sonnet-4-20250514']
};

function initWebUiModelsCache() {
  return {
    updatedAt: 0,
    byProvider: {},
    signature: '',
    source: 'empty'
  };
}

function cloneByProvider(byProvider) {
  const source = byProvider && typeof byProvider === 'object' ? byProvider : {};
  const out = {};
  Object.entries(source).forEach(([provider, models]) => {
    out[provider] = Array.isArray(models) ? models.slice() : [];
  });
  return out;
}

function buildAccountsSignature(state) {
  const parts = [];
  SUPPORTED_SERVER_PROVIDERS.forEach((provider) => {
    const accounts = Array.isArray(state && state.accounts && state.accounts[provider])
      ? state.accounts[provider]
      : [];
    const ids = accounts
      .map((account) => String(account && (account.id || account.accountId) || '').trim())
      .filter(Boolean)
      .sort();
    parts.push(`${provider}:${ids.join(',')}`);
  });
  return parts.join('|');
}

function collectRegistryProviderModels(state) {
  const out = {};
  const registry = state && state.modelRegistry;
  if (!registry || !registry.providers) return out;

  SUPPORTED_SERVER_PROVIDERS.forEach((provider) => {
    const providerModels = registry.providers[provider];
    if (!(providerModels instanceof Set) || providerModels.size === 0) return;
    out[provider] = Array.from(providerModels)
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .sort();
  });
  return out;
}

function mergeModels(targetSet, models) {
  const list = Array.isArray(models) ? models : [];
  list.forEach((item) => {
    const modelId = String(item || '').trim();
    if (modelId) targetSet.add(modelId);
  });
}

async function refreshWebUiModelsCache(state, options, deps = {}) {
  const {
    fetchModelsForAccount
  } = deps;

  const signature = buildAccountsSignature(state);
  const byProvider = {};
  const registryModels = collectRegistryProviderModels(state);
  let source = 'registry';

  SUPPORTED_SERVER_PROVIDERS.forEach((provider) => {
    const merged = new Set();
    mergeModels(merged, registryModels[provider]);

    const accounts = Array.isArray(state && state.accounts && state.accounts[provider])
      ? state.accounts[provider]
      : [];

    accounts.forEach((account) => {
      mergeModels(merged, account && account.availableModels);
    });

    byProvider[provider] = Array.from(merged).sort();
  });

  for (const provider of SUPPORTED_SERVER_PROVIDERS) {
    if (byProvider[provider].length > 0) continue;
    if (typeof fetchModelsForAccount !== 'function') continue;

    const accounts = Array.isArray(state && state.accounts && state.accounts[provider])
      ? state.accounts[provider]
      : [];
    const candidate = accounts.find((account) => account && account.accessToken);
    if (!candidate) continue;

    try {
      const models = await fetchModelsForAccount(options, candidate, 8000);
      byProvider[provider] = Array.isArray(models)
        ? models.map((item) => String(item || '').trim()).filter(Boolean).sort()
        : [];
      if (byProvider[provider].length > 0) source = 'remote';
    } catch (_error) {
      byProvider[provider] = [];
    }
  }

  SUPPORTED_SERVER_PROVIDERS.forEach((provider) => {
    if (byProvider[provider].length > 0) return;
    const accounts = Array.isArray(state && state.accounts && state.accounts[provider])
      ? state.accounts[provider]
      : [];
    if (accounts.length === 0) return;
    byProvider[provider] = (DEFAULT_PROVIDER_MODELS[provider] || []).slice();
    if (byProvider[provider].length > 0 && source === 'registry') {
      source = 'default';
    }
  });

  state.webUiModelsCache = {
    updatedAt: Date.now(),
    byProvider,
    signature,
    source
  };
  return cloneByProvider(byProvider);
}

async function getWebUiModelsCache(state, options, deps = {}) {
  const forceRefresh = Boolean(deps.forceRefresh);
  const nextSignature = buildAccountsSignature(state);
  const cache = state && state.webUiModelsCache;

  if (
    !forceRefresh
    && cache
    && cache.updatedAt > 0
    && cache.signature === nextSignature
  ) {
    return {
      cached: true,
      updatedAt: cache.updatedAt,
      source: cache.source || 'cache',
      models: cloneByProvider(cache.byProvider)
    };
  }

  const models = await refreshWebUiModelsCache(state, options, deps);
  return {
    cached: false,
    updatedAt: state.webUiModelsCache.updatedAt,
    source: state.webUiModelsCache.source || 'refresh',
    models
  };
}

function invalidateWebUiModelsCache(state) {
  state.webUiModelsCache = initWebUiModelsCache();
}

module.exports = {
  initWebUiModelsCache,
  refreshWebUiModelsCache,
  getWebUiModelsCache,
  invalidateWebUiModelsCache,
  buildAccountsSignature
};
