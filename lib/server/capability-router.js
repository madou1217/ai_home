'use strict';

const {
  SUPPORTED_SERVER_PROVIDERS,
  inferProviderFromScopedModelId,
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
  isModelUnavailableForProvider
} = require('./provider-model-availability');
const {
  PROVIDER_PROTOCOL_TRANSPORTS,
  providerProtocolRouteDeclaresModelFamily,
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

// 别名改写后的有效模型：只有 aliasMatched 且 effectiveModel 与 requestedModel 不同时才算
// 「被别名改写过」（请求体里的 model 已由别名替换）。
function readAliasEffectiveModel(aliasResolution) {
  if (!aliasResolution || typeof aliasResolution !== 'object') return '';
  if (aliasResolution.aliasMatched !== true) return '';
  const requestedModel = String(aliasResolution.requestedModel || '').trim();
  const effectiveModel = String(aliasResolution.effectiveModel || '').trim();
  if (!effectiveModel || effectiveModel === requestedModel) return '';
  return effectiveModel;
}

// 别名目标模型自带 provider 专属命名空间时（cline-pass/、opencode(-go)/、agy/、kiro/）的
// 兜底归属：目录没有任何可用账号认领该模型时，回到命名空间所属 provider 的池，
// 而不是按客户端协议亲和挑一个对模型一无所知的池。
// 目录有账号证据时由 resolveProviderByModel 先裁决（target_provider=auto 的既有语义：按目录路由）。
function resolveAliasScopedTargetProvider(aliasEffectiveModel, enabledProviders) {
  const scopedProvider = normalizeProvider(inferProviderFromScopedModelId(aliasEffectiveModel));
  if (!scopedProvider || !enabledProviders.includes(scopedProvider)) return '';
  return scopedProvider;
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
  // 上游明确说过「这个 provider 服务不了这个模型」时不再选它（见 provider-model-availability）。
  // 目录是**声明**（探测所得、可能滞后），负面事实是**实测**（上游刚拒绝过），后者更硬。
  // 没有这一步，同一个错误会随每一次请求重演 —— 2026-10-22 的 gemini-3.5-flash 正是如此。
  if (isModelUnavailableForProvider(provider, model)) return null;
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

function resolveProviderByProtocolRoute(registry, enabledProviders, clientProtocol, requestJson, behavior = {}) {
  const protocol = String(clientProtocol || '').trim();
  if (!protocol) return null;
  const requireModelFamily = behavior.requireModelFamily === true;
  const ranked = enabledProviders
    .map((provider) => {
      const capability = registry.providers[provider];
      if (!capability || Number(capability.availableCount || 0) <= 0) return null;
      const route = resolveProviderProtocolRouteForClientRequest(protocol, provider, requestJson || {});
      if (!route) return null;
      // 别名改写过的请求必须按模型（而不是协议亲和）定 provider：只声明「能讲这个协议」、
      // 对模型没有任何家族证据的路由（opencode go_api、claude/zcode 直通）不能兜底，
      // 否则会把别名目标模型发给不认识它的上游（实测：cline-pass/* 被 opencode 池接走并 503）。
      if (requireModelFamily && !providerProtocolRouteDeclaresModelFamily(route)) return null;
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
    // 家族推断是**弱证据**（只看模型名前缀）。当家族目录**根本不认识**这个模型、而另一个
    // provider 真的探测到了它时，让位给强证据 —— 2026-10-22 的坑：
    // `gemini-3.5-flash` 被前缀推断成 agy，但上游已下架它、agy 目录只剩 `-low`/`-lite`/
    // `-extra-low` 变体；agy 池有账号于是直接短路，产出误导性的
    // `no available agy account can serve model gemini-3.5-flash`，而真正持有该裸名的
    // workbuddy/codebuddy 账号从未被考虑。
    //
    // 判据必须收窄成「家族目录不含该模型」，**不能**只看 byModel 是否另有其人：后者会把
    // 「codex 冷却、claude 中转也宣称支持 gpt-5.5」误判成该走 claude，把配额/冷却问题
    // 伪装成别的 provider 的可用性问题（见 test/server.capability-router.test.js 的
    // codex-truthful 回归）。
    const familyKnowsModel = Boolean(strictFamilyProvider)
      && modelMatchesProvider(registry.providers[strictFamilyProvider], model);
    // 上游已实测拒绝过「家族 provider 服务这个模型」时，不再让它短路 —— 否则每次请求都会
    // 重演同一次失败（2026-10-22 的 gemini-3.5-flash：agy 目录残留该裸名，但上游早已下架）。
    const familyDeniedByUpstream = Boolean(strictFamilyProvider)
      && isModelUnavailableForProvider(strictFamilyProvider, model);
    const familyShortCircuits = !(byModel && byModel.provider !== strictFamilyProvider
      && (!familyKnowsModel || familyDeniedByUpstream));
    if (strictFamilyProvider && enabledProviders.includes(strictFamilyProvider) && familyShortCircuits) {
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

  // 别名改写后的请求：模型（而不是客户端协议）决定 provider。
  // 目标模型自带 provider 专属命名空间时，即使目录里没有任何可用账号认领它，也回到该
  // provider 的池（冷启动时由上游池按弱证据放行，发一次真实请求），绝不按协议亲和外借。
  const aliasEffectiveModel = readAliasEffectiveModel(aliasResolution);
  if (aliasEffectiveModel) {
    const scopedProvider = resolveAliasScopedTargetProvider(aliasEffectiveModel, enabledProviders);
    if (scopedProvider) return { provider: scopedProvider, source: 'alias_target_model_scope' };
  }

  const byAliasRequestModel = resolveProviderByAliasRequestModel(registry, enabledProviders, aliasResolution);
  if (byAliasRequestModel) return byAliasRequestModel;
  const byProtocolRoute = resolveProviderByProtocolRoute(registry, enabledProviders, clientProtocol, requestJson, {
    requireModelFamily: Boolean(aliasEffectiveModel)
  });
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
    readAliasEffectiveModel,
    resolveAliasScopedTargetProvider,
    readRequestProvider,
    readRequestedModel
  }
};
