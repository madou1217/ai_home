'use strict';

const {
  SUPPORTED_SERVER_PROVIDERS,
  isSupportedProvider,
  isDeprecatedGatewayProvider,
  listEnabledProviders
} = require('./providers');
const {
  buildAccountCapabilityRegistry,
  countAvailableAccountsForModel,
  inferModelFamilyProvider,
  modelMatchesProvider
} = require('./account-capabilities');
const {
  PROVIDER_PROTOCOL_TRANSPORTS,
  resolveProviderProtocolRouteForClientRequest
} = require('./provider-protocol-routing');
const {
  isModelEnabled
} = require('./model-catalog-settings-store');

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
  const modelAvailableCount = countAvailableAccountsForModel(capability, model);
  if (modelAvailableCount <= 0) return null;
  return {
    provider,
    source: 'model_capability',
    score: 100 + modelAvailableCount,
    index: SUPPORTED_SERVER_PROVIDERS.indexOf(provider)
  };
}

function resolveProviderByModel(registry, enabledProviders, model) {
  const ranked = enabledProviders
    .map((provider) => rankProviderByModel(registry, provider, model))
    .filter(Boolean)
    .sort((a, b) => {
      // 已废弃 provider（gemini）排最后：gemini-* 模型只要 agy 能服务就优先走 agy，绝不优先死的 gemini。
      const aDep = isDeprecatedGatewayProvider(a.provider) ? 1 : 0;
      const bDep = isDeprecatedGatewayProvider(b.provider) ? 1 : 0;
      if (aDep !== bDep) return aDep - bDep;
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    });
  return ranked.length > 0 ? ranked[0] : null;
}

function resolveProviderByAliasRequestModel(registry, enabledProviders, aliasResolution) {
  if (!aliasResolution || typeof aliasResolution !== 'object') return null;
  const requestedModel = String(aliasResolution.requestedModel || '').trim();
  const effectiveModel = String(aliasResolution.effectiveModel || '').trim();
  if (!requestedModel || !effectiveModel || requestedModel === effectiveModel) return null;
  const byRequestedModel = resolveProviderByModel(registry, enabledProviders, requestedModel);
  if (!byRequestedModel) return null;
  return {
    ...byRequestedModel,
    source: 'alias_requested_model_capability'
  };
}

function findKnownProviderWithoutAvailableAccounts(registry, enabledProviders, model) {
  return enabledProviders.find((provider) => {
    const capability = registry.providers[provider];
    if (!modelMatchesProvider(capability, model)) return false;
    return countAvailableAccountsForModel(capability, model) <= 0;
  }) || '';
}

function resolveProviderByProtocolRoute(registry, enabledProviders, clientProtocol, requestJson) {
  const protocol = String(clientProtocol || '').trim();
  if (!protocol) return null;
  const ranked = enabledProviders
    .map((provider) => {
      const capability = registry.providers[provider];
      if (!capability || Number(capability.availableCount || 0) <= 0) return null;
      const route = resolveProviderProtocolRouteForClientRequest(protocol, provider, requestJson || {});
      if (!route) return null;
      return {
        provider,
        source: 'provider_protocol_route',
        route,
        score: 50 + Number(capability && capability.availableCount || 0),
        index: SUPPORTED_SERVER_PROVIDERS.indexOf(provider)
      };
    })
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

function buildMissingModelResult(registry) {
  return {
    provider: '',
    source: 'missing_model',
    error: 'missing_model',
    detail: 'request model is required for provider routing',
    model: '',
    familyProvider: '',
    availability: {
      provider: 'global',
      total: registry.totalAccounts,
      available: registry.totalAvailable
    }
  };
}

function buildDisabledModelResult(registry, model) {
  return {
    provider: '',
    source: 'disabled_model',
    error: 'model_disabled',
    detail: `model ${model} is disabled in the WebUI model catalog`,
    model,
    familyProvider: '',
    availability: {
      provider: 'global',
      total: registry.totalAccounts,
      available: registry.totalAvailable
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
    preferModelRouting = false,
    aliasResolution = null,
    clientProtocol = ''
  } = input;

  const registry = buildAccountCapabilityRegistry(state, options);
  const enabledProviders = listEnabledProviders(options && options.provider);
  const model = readRequestedModel(requestJson);
  if (!model) return buildMissingModelResult(registry);
  if (!isModelEnabled(state && state.modelCatalogSettings, model)) {
    return buildDisabledModelResult(registry, model);
  }

  const explicit = resolveExplicitProvider(options, requestJson, headers, aliasTargetProvider, { preferModelRouting });
  if (explicit) return explicit;
  const byModel = resolveProviderByModel(registry, enabledProviders, model);

  // 直连请求优先锁定模型家族。唯一例外是家族池没有可用账号、但另一个 provider
  // 对当前客户端协议提供原生直连传输，例如 AGY 的 Claude Anthropic adapter。
  const isExplicitlyAliased = Boolean(aliasTargetProvider) || preferModelRouting === true;
  if (!isExplicitlyAliased) {
    const strictFamilyProvider = inferModelFamilyProvider(model);
    if (strictFamilyProvider && enabledProviders.includes(strictFamilyProvider)) {
      const strictCapability = registry.providers[strictFamilyProvider];
      if (strictCapability && Number(strictCapability.availableCount || 0) > 0) {
        return { provider: strictFamilyProvider, source: 'model_family' };
      }
      const nativeAlternativeRoute = byModel
        ? resolveProviderProtocolRouteForClientRequest(clientProtocol, byModel.provider, requestJson)
        : null;
      if (
        byModel
        && nativeAlternativeRoute
        && nativeAlternativeRoute.transport === PROVIDER_PROTOCOL_TRANSPORTS.CODE_ASSIST_ANTHROPIC_DIRECT
      ) {
        return { ...byModel, source: 'model_capability_protocol_route' };
      }
      return buildUnavailableResult(registry, model, strictFamilyProvider);
    }
  }

  if (byModel) return byModel;
  const byAliasRequestModel = resolveProviderByAliasRequestModel(registry, enabledProviders, aliasResolution);
  if (byAliasRequestModel) return byAliasRequestModel;
  const byProtocolRoute = resolveProviderByProtocolRoute(registry, enabledProviders, clientProtocol, requestJson);
  if (byProtocolRoute) return byProtocolRoute;
  const knownUnavailableProvider = findKnownProviderWithoutAvailableAccounts(registry, enabledProviders, model);
  if (knownUnavailableProvider) {
    return buildUnavailableResult(registry, model, knownUnavailableProvider);
  }
  if (preferModelRouting) {
    return buildUnavailableResult(registry, model, '');
  }

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
    buildDisabledModelResult,
    buildMissingModelResult,
    findKnownProviderWithoutAvailableAccounts,
    firstProviderWithAvailableAccounts,
    readConfiguredProvider,
    readHeaderProvider,
    resolveProviderByProtocolRoute,
    resolveProviderByAliasRequestModel,
    readRequestProvider,
    readRequestedModel
  }
};
