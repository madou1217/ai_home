'use strict';

const {
  SUPPORTED_SERVER_PROVIDERS,
  isSupportedProvider,
  listEnabledProviders
} = require('./providers');
const {
  buildAccountCapabilityRegistry,
  inferModelFamilyProvider,
  modelMatchesProvider
} = require('./account-capabilities');

function normalizeProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  return isSupportedProvider(provider) ? provider : '';
}

function readHeaderProvider(headers = {}) {
  return normalizeProvider(headers['x-provider'] || headers['X-Provider']);
}

function readRequestProvider(requestJson = {}) {
  return normalizeProvider(requestJson && requestJson.provider);
}

function readConfiguredProvider(options = {}) {
  const provider = normalizeProvider(options && options.provider);
  return provider;
}

function readRequestedModel(requestJson = {}) {
  return String(requestJson && requestJson.model || '').trim();
}

function resolveExplicitProvider(options, requestJson, headers, aliasTargetProvider, behavior = {}) {
  const aliasProvider = normalizeProvider(aliasTargetProvider);
  if (aliasProvider) return { provider: aliasProvider, source: 'alias_target_provider' };
  if (behavior.preferModelRouting) return null;

  const headerProvider = readHeaderProvider(headers);
  if (headerProvider) return { provider: headerProvider, source: 'header_provider' };

  const requestProvider = readRequestProvider(requestJson);
  if (requestProvider) return { provider: requestProvider, source: 'request_provider' };

  const configuredProvider = readConfiguredProvider(options);
  if (configuredProvider) return { provider: configuredProvider, source: 'configured_provider' };

  return null;
}

function rankProviderByModel(registry, provider, model) {
  const capability = registry.providers[provider];
  if (!capability || Number(capability.availableCount || 0) <= 0) return null;
  if (!modelMatchesProvider(capability, model)) return null;
  return {
    provider,
    source: 'model_capability',
    score: 100 + Number(capability && capability.availableCount || 0),
    index: SUPPORTED_SERVER_PROVIDERS.indexOf(provider)
  };
}

function resolveProviderByModel(registry, enabledProviders, model) {
  const ranked = enabledProviders
    .map((provider) => rankProviderByModel(registry, provider, model))
    .filter(Boolean)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    });
  return ranked.length > 0 ? ranked[0] : null;
}

function firstProviderWithAvailableAccounts(registry, enabledProviders) {
  return enabledProviders.find((provider) => {
    const capability = registry.providers[provider];
    return capability && Number(capability.availableCount || 0) > 0;
  }) || '';
}

function buildUnavailableResult(registry, model, familyProvider) {
  const providers = {};
  SUPPORTED_SERVER_PROVIDERS.forEach((provider) => {
    const capability = registry.providers[provider] || {};
    providers[provider] = {
      accounts: Number(capability.accountCount || 0),
      available: Number(capability.availableCount || 0),
      models: Array.isArray(capability.modelIds) ? capability.modelIds.length : 0
    };
  });
  return {
    provider: '',
    source: 'unavailable',
    error: 'no_account_supports_model',
    detail: model
      ? `no available account in the global pool can serve model ${model}`
      : 'no account in the global pool is available',
    model,
    familyProvider,
    availability: {
      provider: 'global',
      total: registry.totalAccounts,
      available: registry.totalAvailable,
      providers
    }
  };
}

function resolveGatewayProvider(input = {}) {
  const {
    options = {},
    state = {},
    requestJson = {},
    headers = {},
    aliasTargetProvider = '',
    preferModelRouting = false
  } = input;

  const explicit = resolveExplicitProvider(options, requestJson, headers, aliasTargetProvider, { preferModelRouting });
  if (explicit) return explicit;

  const registry = buildAccountCapabilityRegistry(state, options);
  const enabledProviders = listEnabledProviders(options && options.provider);
  const model = readRequestedModel(requestJson);
  const byModel = resolveProviderByModel(registry, enabledProviders, model);
  if (byModel) return byModel;

  const familyProvider = inferModelFamilyProvider(model);
  if (familyProvider && enabledProviders.includes(familyProvider)) {
    const capability = registry.providers[familyProvider];
    if (capability && Number(capability.availableCount || 0) > 0) {
      return { provider: familyProvider, source: 'model_family' };
    }
    return buildUnavailableResult(registry, model, familyProvider);
  }

  const fallbackProvider = firstProviderWithAvailableAccounts(registry, enabledProviders);
  if (fallbackProvider) return { provider: fallbackProvider, source: 'global_pool_fallback' };

  return buildUnavailableResult(registry, model, familyProvider);
}

module.exports = {
  resolveGatewayProvider,
  __private: {
    buildUnavailableResult,
    firstProviderWithAvailableAccounts,
    readConfiguredProvider,
    readHeaderProvider,
    readRequestProvider,
    readRequestedModel
  }
};
