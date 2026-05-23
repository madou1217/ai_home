'use strict';

const { listEnabledProviders } = require('./providers');

function normalizeModelId(modelRaw) {
  return String(modelRaw || '').trim();
}

function addModels(target, models) {
  if (!(target instanceof Set)) return;
  (Array.isArray(models) ? models : []).forEach((model) => {
    const id = normalizeModelId(model);
    if (id) target.add(id);
  });
}

function sortModels(models) {
  return Array.from(models instanceof Set ? models : new Set(models || []))
    .map((model) => normalizeModelId(model))
    .filter(Boolean)
    .sort();
}

function getProviderAccounts(state, provider) {
  const accounts = state && state.accounts && state.accounts[provider];
  return Array.isArray(accounts) ? accounts : [];
}

function getRegistryModels(state, provider) {
  const providerModels = state
    && state.modelRegistry
    && state.modelRegistry.providers
    && state.modelRegistry.providers[provider];
  return providerModels instanceof Set ? Array.from(providerModels) : [];
}

function getAccountId(account) {
  return String(account && (account.id || account.accountId) || '').trim();
}

function normalizeProviderList(providerMode, includeCodex) {
  return listEnabledProviders(providerMode)
    .filter((provider) => includeCodex || provider !== 'codex');
}

function buildModelDiscoverySignature(state, params = {}) {
  const providerMode = params.providerMode || 'auto';
  const includeCodex = params.includeCodex === true;
  const includeRegistry = params.includeRegistry !== false;
  const includeAccountModels = params.includeAccountModels !== false;
  const providers = normalizeProviderList(providerMode, includeCodex);

  return providers.map((provider) => {
    const registry = includeRegistry ? sortModels(getRegistryModels(state, provider)).join(',') : '';
    const accounts = getProviderAccounts(state, provider)
      .map((account) => {
        const id = getAccountId(account);
        const models = includeAccountModels ? sortModels(account && account.availableModels).join(',') : '';
        return `${id}[${models}]`;
      })
      .sort()
      .join(';');
    return `${provider}:r=${registry}:a=${accounts}`;
  }).join('|');
}

async function discoverProviderModels(params = {}) {
  const {
    state,
    fetchModelsForAccount
  } = params;
  const options = params.options || {};
  const providerMode = params.providerMode || options.provider || 'auto';
  const includeCodex = params.includeCodex === true;
  const includeRegistry = params.includeRegistry !== false;
  const includeAccountModels = params.includeAccountModels !== false;
  const probeCodex = params.probeCodex === true;
  const accountLimit = Math.max(1, Number(params.accountLimit) || 1);
  const timeoutMs = Math.max(1, Number(params.timeoutMs) || 8000);
  const ignoreAvailableModelsSnapshot = params.ignoreAvailableModelsSnapshot !== false;
  const providers = normalizeProviderList(providerMode, includeCodex);
  const localByProvider = {};
  const remoteByProvider = {};
  const byProvider = {};
  const byAccount = {};
  const probeItems = [];
  const probeCounts = new Map();

  providers.forEach((provider) => {
    const localModels = new Set();
    const remoteModels = new Set();
    if (includeRegistry) addModels(localModels, getRegistryModels(state, provider));

    const accounts = getProviderAccounts(state, provider);
    accounts.forEach((account) => {
      if (includeAccountModels) addModels(localModels, account && account.availableModels);
      if (!account || !account.accessToken) return;
      if (provider === 'codex' && !probeCodex) return;
      const count = probeCounts.get(provider) || 0;
      if (count >= accountLimit) return;
      probeItems.push({ provider, account });
      probeCounts.set(provider, count + 1);
    });

    localByProvider[provider] = localModels;
    remoteByProvider[provider] = remoteModels;
  });

  let firstError = '';
  let sourceCount = 0;
  const remoteOptions = ignoreAvailableModelsSnapshot
    ? { ...options, ignoreAvailableModelsSnapshot: true }
    : options;

  if (typeof fetchModelsForAccount === 'function' && probeItems.length > 0) {
    const settled = await Promise.allSettled(
      probeItems.map((item) => fetchModelsForAccount(remoteOptions, item.account, timeoutMs))
    );
    settled.forEach((result, index) => {
      const item = probeItems[index];
      const accountId = getAccountId(item.account) || 'unknown';
      const accountKey = `${item.provider}:${accountId}`;
      if (result.status !== 'fulfilled') {
        byAccount[accountKey] = [];
        if (!firstError) firstError = String((result.reason && result.reason.message) || result.reason || '');
        return;
      }

      const models = sortModels(result.value);
      byAccount[accountKey] = models;
      if (models.length > 0) sourceCount += 1;
      addModels(remoteByProvider[item.provider], models);
    });
  }

  let remoteModelCount = 0;
  let localModelCount = 0;
  providers.forEach((provider) => {
    const remoteModels = remoteByProvider[provider] || new Set();
    const localModels = localByProvider[provider] || new Set();
    remoteModelCount += remoteModels.size;
    localModelCount += localModels.size;
    byProvider[provider] = sortModels(remoteModels.size > 0 ? remoteModels : localModels);
  });

  const allModels = new Set();
  Object.values(byProvider).forEach((models) => addModels(allModels, models));

  return {
    byProvider,
    ids: sortModels(allModels),
    byAccount,
    scannedAccounts: probeItems.length,
    sourceCount,
    firstError,
    source: remoteModelCount > 0 ? 'remote' : (localModelCount > 0 ? 'local' : 'empty'),
    signature: buildModelDiscoverySignature(state, {
      providerMode,
      includeCodex,
      includeRegistry,
      includeAccountModels
    })
  };
}

module.exports = {
  discoverProviderModels,
  buildModelDiscoverySignature
};
