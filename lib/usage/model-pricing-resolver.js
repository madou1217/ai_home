'use strict';

const {
  calculateCostUsd,
  matchModelPricing
} = require('./model-usage-pricing');

const PRICING_RESOLUTION_STATUS = Object.freeze({
  PRICED: 'priced',
  KNOWN_ZERO: 'known_zero',
  UNKNOWN: 'unknown'
});

function normalizeText(value) {
  return String(value || '').trim();
}

function isKnownZeroPricing(pricing) {
  if (!pricing || typeof pricing !== 'object') return false;
  const values = [
    pricing.inputCostPerToken,
    pricing.outputCostPerToken,
    pricing.cacheReadInputTokenCost,
    pricing.cacheCreationInputTokenCost,
    pricing.reasoningOutputTokenCost,
    ...(Array.isArray(pricing.contextCostTiers)
      ? pricing.contextCostTiers.flatMap((tier) => [
          tier && tier.inputCostPerToken,
          tier && tier.outputCostPerToken,
          tier && tier.cacheReadInputTokenCost,
          tier && tier.cacheCreationInputTokenCost,
          tier && tier.reasoningOutputTokenCost
        ])
      : [])
  ].filter((value) => value !== null && value !== undefined && value !== '');
  return values.length > 0 && values.every((value) => Number(value) === 0);
}

function unknownResolution(input = {}) {
  return {
    status: PRICING_RESOLUTION_STATUS.UNKNOWN,
    sourceProviderId: normalizeText(input.sourceProviderId),
    requestedModel: normalizeText(input.model),
    executionProvider: normalizeText(input.provider).toLowerCase(),
    matchedModel: '',
    pricing: null
  };
}

function normalizeResolution(result, input, sourceProviderId) {
  if (!result || typeof result !== 'object' || !result.pricing) {
    return unknownResolution({ ...input, sourceProviderId });
  }
  const pricing = result.pricing;
  const status = result.status === PRICING_RESOLUTION_STATUS.KNOWN_ZERO
    || isKnownZeroPricing(pricing)
    ? PRICING_RESOLUTION_STATUS.KNOWN_ZERO
    : PRICING_RESOLUTION_STATUS.PRICED;
  return {
    ...result,
    status,
    sourceProviderId,
    requestedModel: normalizeText(input.model),
    executionProvider: normalizeText(input.provider).toLowerCase(),
    matchedModel: normalizeText(result.matchedModel || pricing.model),
    pricing
  };
}

function normalizeProvider(provider) {
  const id = normalizeText(provider && provider.id);
  if (!id || !provider || typeof provider.resolve !== 'function') {
    throw new Error('model_pricing_provider_invalid');
  }
  return { ...provider, id };
}

function createModelPricingResolver(options = {}) {
  const providers = (Array.isArray(options.providers) ? options.providers : [])
    .map(normalizeProvider);
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));

  function resolve(input = {}, context = {}) {
    const sourceProviderId = normalizeText(input.sourceProviderId || context.sourceProviderId);
    const selectedProviders = sourceProviderId
      ? [providersById.get(sourceProviderId)].filter(Boolean)
      : providers;

    for (const provider of selectedProviders) {
      const result = provider.resolve(input, context);
      if (result && result.status !== PRICING_RESOLUTION_STATUS.UNKNOWN && result.pricing) {
        return normalizeResolution(result, input, provider.id);
      }
    }

    const pricingByModel = context.pricingByModel;
    if (pricingByModel && typeof pricingByModel === 'object') {
      const pricing = matchModelPricing(input.model, pricingByModel, input.provider);
      if (pricing) {
        return normalizeResolution({ pricing, matchedModel: pricing.model }, input, sourceProviderId);
      }
    }
    return unknownResolution({ ...input, sourceProviderId });
  }

  function calculateCost(input = {}, context = {}) {
    const resolution = resolve(input, context);
    return {
      ...resolution,
      costUsd: resolution.status === PRICING_RESOLUTION_STATUS.UNKNOWN
        ? null
        : calculateCostUsd(input, resolution.pricing)
    };
  }

  function getProvider(id) {
    return providersById.get(normalizeText(id)) || null;
  }

  return {
    calculateCost,
    getProvider,
    listProviderIds: () => providers.map((provider) => provider.id),
    resolve
  };
}

module.exports = {
  PRICING_RESOLUTION_STATUS,
  createModelPricingResolver,
  isKnownZeroPricing
};
