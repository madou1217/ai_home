'use strict';

const {
  discoverProviderModels,
  buildModelDiscoverySignature
} = require('./provider-model-discovery');

function initWebUiModelsCache() {
  return {
    updatedAt: 0,
    byProvider: {},
    signature: '',
    source: 'empty',
    sourceCount: 0,
    scannedAccounts: 0,
    firstError: ''
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
  return buildModelDiscoverySignature(state, {
    providerMode: 'auto',
    includeCodex: true
  });
}

async function refreshWebUiModelsCache(state, options, deps = {}) {
  const {
    fetchModelsForAccount
  } = deps;

  const discovery = await discoverProviderModels({
    state,
    options,
    fetchModelsForAccount,
    providerMode: 'auto',
    includeCodex: true,
    accountLimit: 1,
    timeoutMs: 8000
  });

  state.webUiModelsCache = {
    updatedAt: Date.now(),
    byProvider: discovery.byProvider,
    signature: discovery.signature,
    source: discovery.source,
    sourceCount: discovery.sourceCount,
    scannedAccounts: discovery.scannedAccounts,
    firstError: discovery.firstError
  };
  return cloneByProvider(discovery.byProvider);
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
      sourceCount: Number(cache.sourceCount || 0),
      scannedAccounts: Number(cache.scannedAccounts || 0),
      firstError: cache.firstError || '',
      models: cloneByProvider(cache.byProvider)
    };
  }

  const models = await refreshWebUiModelsCache(state, options, deps);
  return {
    cached: false,
    updatedAt: state.webUiModelsCache.updatedAt,
    source: state.webUiModelsCache.source || 'refresh',
    sourceCount: Number(state.webUiModelsCache.sourceCount || 0),
    scannedAccounts: Number(state.webUiModelsCache.scannedAccounts || 0),
    firstError: state.webUiModelsCache.firstError || '',
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
