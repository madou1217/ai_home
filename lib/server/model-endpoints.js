'use strict';
const {
  discoverProviderModels,
  buildModelDiscoverySignature
} = require('./provider-model-discovery');

async function buildManagementModelsResponse(params) {
  const {
    options,
    state,
    url,
    fetchModelsForAccount
  } = params;

  const forceRefresh = ['1', 'true', 'yes'].includes(String(url.searchParams.get('refresh') || '').toLowerCase());
  const accountLimitRaw = String(url.searchParams.get('accounts') || '').trim();
  const accountLimit = /^\d+$/.test(accountLimitRaw) ? Math.max(1, Number(accountLimitRaw)) : 3;
  const cacheTtlRaw = String(url.searchParams.get('ttl_ms') || '').trim();
  const cacheTtl = /^\d+$/.test(cacheTtlRaw) ? Math.max(1000, Number(cacheTtlRaw)) : 5 * 60 * 1000;
  const now = Date.now();
  const providerMode = options && options.provider || 'auto';
  const signature = `${buildModelDiscoverySignature(state, {
    providerMode,
    includeCodex: false
  })}|limit=${accountLimit}`;

  if (
    !forceRefresh
    && state.modelsCache.updatedAt > 0
    && now - state.modelsCache.updatedAt < cacheTtl
    && state.modelsCache.signature === signature
  ) {
    return {
      status: 200,
      payload: {
        ok: true,
        cached: true,
        updatedAt: state.modelsCache.updatedAt,
        sources: state.modelsCache.sourceCount,
        scannedAccounts: state.modelsCache.scannedAccounts || 0,
        source: state.modelsCache.source || 'cache',
        firstError: state.modelsCache.firstError || '',
        models: state.modelsCache.ids
      }
    };
  }

  const discovery = await discoverProviderModels({
    state,
    options,
    fetchModelsForAccount,
    providerMode,
    includeCodex: false,
    accountLimit,
    timeoutMs: 8000
  });
  const ids = discovery.ids;
  state.modelsCache = {
    updatedAt: now,
    ids,
    byProvider: discovery.byProvider,
    byAccount: discovery.byAccount,
    sourceCount: discovery.sourceCount,
    scannedAccounts: discovery.scannedAccounts,
    firstError: discovery.firstError,
    source: discovery.source,
    signature
  };

  return {
    status: 200,
    payload: {
      ok: true,
      cached: false,
      updatedAt: state.modelsCache.updatedAt,
      scannedAccounts: discovery.scannedAccounts,
      sources: discovery.sourceCount,
      source: discovery.source,
      models: ids,
      firstError: discovery.firstError
    }
  };
}

module.exports = {
  buildManagementModelsResponse
};
