'use strict';

const crypto = require('node:crypto');
const {
  resolveBillingIdentity,
  __private: { normalizeVersionSeparators }
} = require('./model-usage-identity');

const PRICING_CATALOG_FORMAT_VERSION = 'v2';
const PRICING_MATCHER_CACHE = new WeakMap();

const PROVIDER_PREFIXES = Object.freeze([
  'anthropic/',
  'openai/',
  'github-copilot/',
  'deepseek/',
  'gemini/',
  'google/',
  'google-vertex/',
  'mistral/',
  'cohere/',
  'azure_ai/'
]);

const PROVIDER_PREFIXES_BY_AIH_PROVIDER = Object.freeze({
  codex: Object.freeze(['openai/', 'github-copilot/']),
  claude: Object.freeze(['anthropic/']),
  gemini: Object.freeze(['google/', 'google-vertex/']),
  agy: Object.freeze(['github-copilot/', 'google/', 'google-vertex/', 'anthropic/', 'openai/']),
  opencode: Object.freeze(['opencode-go/', 'opencode/'])
});

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function optionalFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeModelForMatch(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\//g, '.');
}

function uniqueItems(items = []) {
  return Array.from(new Set(items.filter(Boolean)));
}

function getCandidatePrefixes(provider) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  return uniqueItems([
    ...(PROVIDER_PREFIXES_BY_AIH_PROVIDER[normalizedProvider] || []),
    ...PROVIDER_PREFIXES
  ]);
}

function createModelPricingMatcher(pricingByModel = {}) {
  const exactPricing = new Map();
  const normalizedPricing = new Map();
  Object.entries(pricingByModel || {}).forEach(([key, value]) => {
    const exactKey = String(key || '').trim();
    const normalizedKey = exactKey.toLowerCase();
    if (exactKey && !exactPricing.has(exactKey)) {
      exactPricing.set(exactKey, value);
    }
    if (normalizedKey && !normalizedPricing.has(normalizedKey)) {
      normalizedPricing.set(normalizedKey, value);
    }
  });

  return function matchSnapshotModel(model, provider = '') {
    const modelId = String(model || '').trim();
    if (!modelId) return null;

    const identity = resolveBillingIdentity(modelId, provider);
    const candidatePrefixes = uniqueItems([
      ...identity.providerPrefixes,
      ...getCandidatePrefixes(identity.executionProvider || provider)
    ]);
    const findExact = (candidate) => (
      exactPricing.get(String(candidate || '').trim())
      || normalizedPricing.get(String(candidate || '').trim().toLowerCase())
      || null
    );

    for (const prefix of candidatePrefixes) {
      for (const candidateModelId of identity.modelIds) {
        const match = findExact(`${prefix}${candidateModelId}`);
        if (match) return match;
      }
    }

    for (const candidateModelId of identity.modelIds) {
      const match = findExact(candidateModelId);
      if (match) return match;
    }
    return null;
  };
}

function getModelPricingMatcher(pricingByModel) {
  if (!pricingByModel || (typeof pricingByModel !== 'object' && typeof pricingByModel !== 'function')) {
    return createModelPricingMatcher({});
  }
  let matcher = PRICING_MATCHER_CACHE.get(pricingByModel);
  if (!matcher) {
    matcher = createModelPricingMatcher(pricingByModel);
    PRICING_MATCHER_CACHE.set(pricingByModel, matcher);
  }
  return matcher;
}

function matchModelPricing(model, pricingByModel = {}, provider = '') {
  return getModelPricingMatcher(pricingByModel)(model, provider);
}

function getBillableContextTokens(record = {}) {
  return (
    finiteNumber(record.inputTokens)
    + finiteNumber(record.cacheReadInputTokens)
    + finiteNumber(record.cacheCreationInputTokens)
  );
}

function selectContextPricing(record = {}, pricing = {}) {
  const tiers = Array.isArray(pricing.contextCostTiers) ? pricing.contextCostTiers : [];
  if (tiers.length < 1) return pricing;
  const contextTokens = getBillableContextTokens(record);
  let selected = null;
  tiers.forEach((tier) => {
    const size = finiteNumber(tier && tier.size);
    if (!size || contextTokens < size) return;
    if (!selected || size > selected.size) selected = { ...tier, size };
  });
  if (!selected) return pricing;
  return {
    ...pricing,
    inputCostPerToken: selected.inputCostPerToken ?? pricing.inputCostPerToken,
    outputCostPerToken: selected.outputCostPerToken ?? pricing.outputCostPerToken,
    cacheReadInputTokenCost: selected.cacheReadInputTokenCost ?? pricing.cacheReadInputTokenCost,
    cacheCreationInputTokenCost: selected.cacheCreationInputTokenCost ?? pricing.cacheCreationInputTokenCost,
    reasoningOutputTokenCost: selected.reasoningOutputTokenCost ?? pricing.reasoningOutputTokenCost
  };
}

function calculateCostUsd(record = {}, pricing = null) {
  if (!pricing || typeof pricing !== 'object') return 0;
  const effectivePricing = selectContextPricing(record, pricing);
  const inputPrice = finiteNumber(effectivePricing.inputCostPerToken);
  const outputPrice = finiteNumber(effectivePricing.outputCostPerToken);
  const cacheReadPrice = finiteNumber(effectivePricing.cacheReadInputTokenCost);
  const cacheCreatePrice = finiteNumber(effectivePricing.cacheCreationInputTokenCost);
  const declaredReasoningPrice = optionalFiniteNumber(effectivePricing.reasoningOutputTokenCost);
  const reasoningPrice = declaredReasoningPrice === null ? outputPrice : declaredReasoningPrice;

  return (
    finiteNumber(record.inputTokens) * inputPrice
    + finiteNumber(record.outputTokens) * outputPrice
    + finiteNumber(record.cacheReadInputTokens) * cacheReadPrice
    + finiteNumber(record.cacheCreationInputTokens) * cacheCreatePrice
    + finiteNumber(record.reasoningOutputTokens) * reasoningPrice
  );
}

function normalizeContextCostTiers(value) {
  const source = Array.isArray(value) ? value : [];
  return source
    .map((tier) => {
      const size = optionalFiniteNumber(tier && (tier.size ?? tier.contextSize ?? tier.context_size));
      if (!size) return null;
      return {
        size,
        inputCostPerToken: optionalFiniteNumber(tier.inputCostPerToken ?? tier.input_cost_per_token),
        outputCostPerToken: optionalFiniteNumber(tier.outputCostPerToken ?? tier.output_cost_per_token),
        cacheReadInputTokenCost: optionalFiniteNumber(tier.cacheReadInputTokenCost ?? tier.cache_read_input_token_cost),
        cacheCreationInputTokenCost: optionalFiniteNumber(tier.cacheCreationInputTokenCost ?? tier.cache_creation_input_token_cost),
        reasoningOutputTokenCost: optionalFiniteNumber(tier.reasoningOutputTokenCost ?? tier.reasoning_output_token_cost)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.size - b.size);
}

function normalizePricingRecord(model, value = {}) {
  const modelId = String(model || value.model || '').trim();
  if (!modelId) return null;
  const inputCostPerToken = finiteNumber(value.inputCostPerToken ?? value.input_cost_per_token);
  const outputCostPerToken = finiteNumber(value.outputCostPerToken ?? value.output_cost_per_token);
  const cacheReadInputTokenCost = finiteNumber(value.cacheReadInputTokenCost ?? value.cache_read_input_token_cost);
  const cacheCreationInputTokenCost = finiteNumber(value.cacheCreationInputTokenCost ?? value.cache_creation_input_token_cost);
  const reasoningOutputTokenCost = optionalFiniteNumber(
    value.reasoningOutputTokenCost ?? value.reasoning_output_token_cost
  );
  const contextCostTiers = normalizeContextCostTiers(value.contextCostTiers ?? value.context_cost_tiers);
  if (
    !inputCostPerToken
    && !outputCostPerToken
    && !cacheReadInputTokenCost
    && !cacheCreationInputTokenCost
    && reasoningOutputTokenCost === null
    && contextCostTiers.length < 1
  ) {
    return null;
  }
  return {
    model: modelId,
    inputCostPerToken,
    outputCostPerToken,
    cacheReadInputTokenCost,
    cacheCreationInputTokenCost,
    reasoningOutputTokenCost,
    contextCostTiers
  };
}

function fingerprintPricingCatalog(records = []) {
  const normalized = (Array.isArray(records) ? records : [])
    .map((record) => normalizePricingRecord(record && record.model, record))
    .filter(Boolean)
    .map((record) => [
      record.model.toLowerCase(),
      record.inputCostPerToken,
      record.outputCostPerToken,
      record.cacheReadInputTokenCost,
      record.cacheCreationInputTokenCost,
      record.reasoningOutputTokenCost,
      record.contextCostTiers.map((tier) => [
        tier.size,
        tier.inputCostPerToken,
        tier.outputCostPerToken,
        tier.cacheReadInputTokenCost,
        tier.cacheCreationInputTokenCost,
        tier.reasoningOutputTokenCost
      ])
    ])
    .sort((left, right) => {
      if (left[0] < right[0]) return -1;
      if (left[0] > right[0]) return 1;
      return 0;
    });
  if (normalized.length === 0) return '';
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(normalized))
    .digest('hex');
}

function parseLiteLlmPricing(raw = {}) {
  const out = {};
  Object.entries(raw && typeof raw === 'object' ? raw : {}).forEach(([model, value]) => {
    const record = normalizePricingRecord(model, value);
    if (!record) return;
    out[record.model] = record;
  });
  return out;
}

module.exports = {
  PRICING_CATALOG_FORMAT_VERSION,
  calculateCostUsd,
  createModelPricingMatcher,
  fingerprintPricingCatalog,
  matchModelPricing,
  normalizePricingRecord,
  parseLiteLlmPricing,
  __private: {
    finiteNumber,
    getCandidatePrefixes,
    getModelPricingMatcher,
    normalizeModelForMatch,
    normalizeVersionSeparators,
    selectContextPricing
  }
};
