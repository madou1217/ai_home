'use strict';

const { isPublicCatalogModelId } = require('./model-id');

const PROVIDER_DEFAULT_MODELS = Object.freeze({});

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function addModels(out, models) {
  (Array.isArray(models) ? models : []).forEach((model) => {
    const id = String(model || '').trim();
    if (isPublicCatalogModelId(id) && !out.includes(id)) out.push(id);
  });
}

function addRegistryModels(out, state, provider) {
  const registryModels = state
    && state.modelRegistry
    && state.modelRegistry.providers
    && state.modelRegistry.providers[provider];
  if (!(registryModels instanceof Set)) return;
  addModels(out, Array.from(registryModels));
}

function collectProviderDefaultCandidates(providerRaw, source = {}) {
  const provider = normalizeProvider(providerRaw);
  const state = source && source.state && typeof source.state === 'object' ? source.state : {};
  const out = [];

  addModels(out, state && state.webUiModelsCache && state.webUiModelsCache.byProvider && state.webUiModelsCache.byProvider[provider]);
  addRegistryModels(out, state, provider);
  return out;
}

function resolveProviderDefaultModel(provider, fallback = '', source = {}) {
  const candidates = collectProviderDefaultCandidates(provider, source);
  return candidates[0] || String(fallback || '').trim();
}

module.exports = {
  PROVIDER_DEFAULT_MODELS,
  collectProviderDefaultCandidates,
  resolveProviderDefaultModel
};
