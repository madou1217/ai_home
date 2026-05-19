'use strict';

const SUPPORTED_SERVER_PROVIDERS = Object.freeze(['codex', 'gemini', 'claude']);

function normalizeModelId(modelRaw) {
  return String(modelRaw || '').trim().toLowerCase();
}

function inferProviderFromModel(modelRaw) {
  const model = normalizeModelId(modelRaw);
  if (!model) return 'codex';
  if (model.startsWith('gemini')) return 'gemini';
  if (model.startsWith('claude') || model.startsWith('anthropic')) return 'claude';
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) return 'codex';
  return 'codex';
}

function isSupportedProvider(providerRaw) {
  const provider = String(providerRaw || '').trim().toLowerCase();
  return SUPPORTED_SERVER_PROVIDERS.includes(provider);
}

function listEnabledProviders(providerMode) {
  const mode = String(providerMode || '').trim().toLowerCase();
  if (mode === 'auto') return SUPPORTED_SERVER_PROVIDERS.slice();
  if (isSupportedProvider(mode)) return [mode];
  return SUPPORTED_SERVER_PROVIDERS.slice();
}

module.exports = {
  SUPPORTED_SERVER_PROVIDERS,
  normalizeModelId,
  inferProviderFromModel,
  isSupportedProvider,
  listEnabledProviders
};
