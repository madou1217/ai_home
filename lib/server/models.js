'use strict';

const { SUPPORTED_SERVER_PROVIDERS, listEnabledProviders } = require('./providers');

const FALLBACK_MODELS = [];

function normalizeModelId(modelRaw) {
  return String(modelRaw || '').trim().toLowerCase();
}

function initModelRegistry() {
  const providers = {};
  SUPPORTED_SERVER_PROVIDERS.forEach((provider) => {
    providers[provider] = new Set();
  });
  return {
    updatedAt: Date.now(),
    providers
  };
}

function addModelToRegistry(registry, provider, model) {
  if (!registry || !registry.providers) return;
  if (!provider || !registry.providers[provider]) return;
  const m = normalizeModelId(model);
  if (!m) return;
  registry.providers[provider].add(m);
  registry.updatedAt = Date.now();
}

function getRegistryModelList(registry, providerMode = 'auto') {
  if (!registry || !registry.providers) return FALLBACK_MODELS.slice();
  const out = new Set();
  const providers = listEnabledProviders(providerMode);
  providers.forEach((provider) => {
    const providerModels = registry.providers && registry.providers[provider];
    if (!(providerModels instanceof Set)) return;
    providerModels.forEach((m) => out.add(m));
  });
  if (out.size === 0) return FALLBACK_MODELS.slice();
  return Array.from(out).sort();
}

function buildOpenAIModelsList(models) {
  const now = Math.floor(Date.now() / 1000);
  const safe = Array.isArray(models) ? models : [];
  return {
    object: 'list',
    data: safe.map((id) => ({
      id,
      object: 'model',
      created: now,
      owned_by: 'aih-server'
    }))
  };
}

module.exports = {
  FALLBACK_MODELS,
  initModelRegistry,
  addModelToRegistry,
  getRegistryModelList,
  buildOpenAIModelsList
};
