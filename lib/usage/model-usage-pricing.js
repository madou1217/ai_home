'use strict';

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

function normalizeVersionSeparators(value) {
  return String(value || '')
    .replace(/4\.6/g, '4-6')
    .replace(/4\.5/g, '4-5')
    .replace(/3\.5/g, '3-5')
    .replace(/5\.4/g, '5-4');
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

function matchModelPricing(model, pricingByModel = {}, provider = '') {
  const modelId = String(model || '').trim();
  if (!modelId) return null;

  const candidatePrefixes = getCandidatePrefixes(provider);
  for (const prefix of candidatePrefixes) {
    const candidate = `${prefix}${modelId}`;
    if (pricingByModel[candidate]) return pricingByModel[candidate];
  }

  if (pricingByModel[modelId]) return pricingByModel[modelId];

  const normalized = normalizeModelForMatch(modelId);
  const normalizedDash = normalizeVersionSeparators(normalized);
  let bestKey = '';
  let bestScore = 0;

  Object.keys(pricingByModel || {}).forEach((key) => {
    const keyNormalized = normalizeModelForMatch(key);
    [normalized, normalizedDash].forEach((candidate) => {
      if (!candidate) return;
      if (!keyNormalized.includes(candidate) && !candidate.includes(keyNormalized)) return;
      let score = 10000 - key.length;
      const prefixIndex = candidatePrefixes.findIndex((prefix) => key.startsWith(prefix));
      if (prefixIndex >= 0) score += 100000 - (prefixIndex * 1000);
      if (keyNormalized === candidate) score += 100000;
      if (score > bestScore) {
        bestKey = key;
        bestScore = score;
      }
    });
  });

  return bestKey ? pricingByModel[bestKey] : null;
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
  const reasoningPrice = finiteNumber(effectivePricing.reasoningOutputTokenCost);

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
  const reasoningOutputTokenCost = finiteNumber(value.reasoningOutputTokenCost ?? value.reasoning_output_token_cost);
  const contextCostTiers = normalizeContextCostTiers(value.contextCostTiers ?? value.context_cost_tiers);
  if (
    !inputCostPerToken
    && !outputCostPerToken
    && !cacheReadInputTokenCost
    && !cacheCreationInputTokenCost
    && !reasoningOutputTokenCost
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
  calculateCostUsd,
  matchModelPricing,
  normalizePricingRecord,
  parseLiteLlmPricing,
  __private: {
    finiteNumber,
    getCandidatePrefixes,
    normalizeModelForMatch,
    normalizeVersionSeparators,
    selectContextPricing
  }
};
