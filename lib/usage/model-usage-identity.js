'use strict';

const USAGE_PROVIDERS = new Set(['claude', 'codex', 'gemini', 'agy', 'opencode']);

const BILLING_ALIASES = Object.freeze({
  'gemini-3-flash-agent': Object.freeze({
    modelId: 'gemini-3.5-flash',
    providerPrefixes: Object.freeze(['google/', 'google-vertex/', 'github-copilot/'])
  }),
  'gemini-3-flash-a': Object.freeze({
    modelId: 'gemini-3.5-flash',
    providerPrefixes: Object.freeze(['google/', 'google-vertex/', 'github-copilot/'])
  }),
  'gemini-default': Object.freeze({
    modelId: 'gemini-3.5-flash',
    providerPrefixes: Object.freeze(['google/', 'google-vertex/', 'github-copilot/'])
  }),
  'claude-opus-4-6-thinking': Object.freeze({
    modelId: 'claude-opus-4-6',
    providerPrefixes: Object.freeze(['anthropic/', 'github-copilot/'])
  })
});

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeModelId(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeVersionSeparators(value) {
  return normalizeModelId(value)
    .replace(/4\.6/g, '4-6')
    .replace(/4\.5/g, '4-5')
    .replace(/3\.5/g, '3-5')
    .replace(/5\.4/g, '5-4');
}

function uniqueItems(items = []) {
  return Array.from(new Set(items.filter(Boolean)));
}

function parseAttributedModel(value, fallbackProvider = '') {
  const rawModel = String(value || '').trim();
  const separator = rawModel.indexOf('.');
  const prefix = separator > 0 ? normalizeProvider(rawModel.slice(0, separator)) : '';
  if (prefix && USAGE_PROVIDERS.has(prefix)) {
    return {
      attributed: true,
      executionProvider: prefix,
      modelId: rawModel.slice(separator + 1).trim()
    };
  }
  return {
    attributed: false,
    executionProvider: normalizeProvider(fallbackProvider),
    modelId: rawModel
  };
}

function resolveBillingIdentity(value, fallbackProvider = '') {
  const attributed = parseAttributedModel(value, fallbackProvider);
  const variants = uniqueItems([
    normalizeModelId(attributed.modelId),
    normalizeVersionSeparators(attributed.modelId)
  ]);
  const alias = variants.map((variant) => BILLING_ALIASES[variant]).find(Boolean) || null;
  const modelIds = alias
    ? uniqueItems([alias.modelId, normalizeVersionSeparators(alias.modelId)])
    : variants;
  return {
    ...attributed,
    modelIds,
    providerPrefixes: alias ? alias.providerPrefixes.slice() : []
  };
}

function formatAttributedModel(clientProvider, executionProvider, model) {
  const client = normalizeProvider(clientProvider);
  const parsed = parseAttributedModel(model, executionProvider);
  const execution = normalizeProvider(executionProvider || parsed.executionProvider);
  const modelId = String(parsed.modelId || '').trim();
  if (!modelId) return '';
  return client && execution && client !== execution
    ? `${execution}.${modelId}`
    : modelId;
}

module.exports = {
  formatAttributedModel,
  parseAttributedModel,
  resolveBillingIdentity,
  __private: {
    BILLING_ALIASES,
    normalizeModelId,
    normalizeProvider,
    normalizeVersionSeparators,
    uniqueItems
  }
};
