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

function inferModelOwnerFromId(id) {
  if (id.startsWith('claude-') || id.startsWith('anthropic.')) return 'anthropic';
  if (id.startsWith('gemini-') || id.includes('google')) return 'google';
  if (id.startsWith('opencode-go/') || id.startsWith('opencode/') || id.startsWith('opencode-')) return 'opencode';
  if (id.startsWith('gpt-') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4')) return 'openai';
  return '';
}

function inferModelOwnerFromProvider(provider) {
  if (provider === 'claude') return 'anthropic';
  if (provider === 'gemini') return 'google';
  if (provider === 'codex') return 'openai';
  if (provider === 'opencode') return 'opencode';
  return '';
}

function buildOpenAIModelsList(models) {
  const now = Math.floor(Date.now() / 1000);
  const safe = Array.isArray(models) ? models : [];
  return {
    object: 'list',
    data: safe.map((item) => {
      const id = typeof item === 'string' ? item : (item.id || '');
      const provider = typeof item === 'object' ? item.provider : '';
      const owned_by = inferModelOwnerFromId(id)
        || inferModelOwnerFromProvider(provider)
        || 'aih-server';

      const modelObj = {
        id,
        object: 'model',
        created: now,
        owned_by
      };

      // NOTE: We strip ALL custom metadata fields (like aih_metadata) from the final model object.
      // Strict clients like Claude Code (anthropic-ai/claude-code) may reject models
      // with unrecognized schema fields.
      return modelObj;
    })
  };
}

module.exports = {
  FALLBACK_MODELS,
  initModelRegistry,
  addModelToRegistry,
  getRegistryModelList,
  buildOpenAIModelsList
};
