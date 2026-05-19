'use strict';

const {
  SUPPORTED_SERVER_PROVIDERS,
  inferProviderFromModel,
  listEnabledProviders,
  normalizeModelId
} = require('./providers');

function normalizeExplicitProvider(providerRaw) {
  const provider = String(providerRaw || '').trim().toLowerCase();
  return SUPPORTED_SERVER_PROVIDERS.includes(provider) ? provider : '';
}

function getRequestedModel(requestJson) {
  return String(requestJson && requestJson.model || '').trim();
}

function hasModel(models, requestedModel) {
  const wanted = normalizeModelId(requestedModel);
  if (!wanted || !Array.isArray(models)) return false;
  return models.some((item) => normalizeModelId(item) === wanted);
}

function registryHasModel(state, provider, requestedModel) {
  const providerModels = state
    && state.modelRegistry
    && state.modelRegistry.providers
    && state.modelRegistry.providers[provider];
  if (!(providerModels instanceof Set)) return false;
  return providerModels.has(normalizeModelId(requestedModel));
}

function cacheHasModel(state, provider, requestedModel) {
  const models = state
    && state.webUiModelsCache
    && state.webUiModelsCache.byProvider
    && state.webUiModelsCache.byProvider[provider];
  return hasModel(models, requestedModel);
}

function accountsHaveModel(state, provider, requestedModel) {
  const accounts = Array.isArray(state && state.accounts && state.accounts[provider])
    ? state.accounts[provider]
    : [];
  return accounts.some((account) => hasModel(account && account.availableModels, requestedModel));
}

function getModelAvailabilityScore(state, provider, requestedModel) {
  let score = 0;
  if (accountsHaveModel(state, provider, requestedModel)) score += 100;
  if (cacheHasModel(state, provider, requestedModel)) score += 80;
  if (registryHasModel(state, provider, requestedModel)) score += 70;
  return score;
}

function inferKnownProviderFamily(modelRaw) {
  const model = normalizeModelId(modelRaw);
  if (!model) return '';
  if (model.startsWith('gemini')) return 'gemini';
  if (model.startsWith('claude') || model.startsWith('anthropic')) return 'claude';
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) return 'codex';
  return '';
}

function resolveByModelAvailability(options, requestJson, state) {
  const requestedModel = getRequestedModel(requestJson);
  if (!requestedModel) return '';

  const providers = listEnabledProviders(options && options.provider);
  const familyProvider = inferKnownProviderFamily(requestedModel);
  const ranked = providers
    .map((provider) => {
      const availabilityScore = getModelAvailabilityScore(state, provider, requestedModel);
      const familyScore = familyProvider === provider ? 5 : 0;
      return {
        provider,
        score: availabilityScore + familyScore,
        availabilityScore,
        familyScore,
        index: SUPPORTED_SERVER_PROVIDERS.indexOf(provider)
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.availabilityScore !== a.availabilityScore) return b.availabilityScore - a.availabilityScore;
      return a.index - b.index;
    });

  return ranked.length > 0 ? ranked[0].provider : '';
}

function resolveRequestProvider(options = {}, requestJson = {}, reqHeaders = {}, state = null) {
  const explicitHeaderProvider = normalizeExplicitProvider(
    reqHeaders && (reqHeaders['x-provider'] || reqHeaders['X-Provider'])
  );
  if (explicitHeaderProvider) return explicitHeaderProvider;

  const explicitRequestProvider = normalizeExplicitProvider(requestJson && requestJson.provider);
  if (explicitRequestProvider) return explicitRequestProvider;

  const configuredProvider = normalizeExplicitProvider(options && options.provider);
  if (configuredProvider) return configuredProvider;

  const availabilityProvider = resolveByModelAvailability(options, requestJson, state);
  if (availabilityProvider) return availabilityProvider;

  return inferProviderFromModel(getRequestedModel(requestJson));
}

module.exports = {
  resolveRequestProvider,
  normalizeExplicitProvider,
  __private: {
    getRequestedModel,
    hasModel,
    accountsHaveModel,
    cacheHasModel,
    registryHasModel,
    resolveByModelAvailability,
    inferKnownProviderFamily
  }
};
