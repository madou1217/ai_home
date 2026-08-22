'use strict';

const {
  buildModelsDevPricingRecords,
  inferBaseModelIds,
  inferModelsDevProviderIds,
  __private: { loadModelsDevCatalog }
} = require('../../server/models-dev-metadata');
const {
  fingerprintPricingCatalog
} = require('../model-usage-pricing');
const {
  resolveBillingIdentity,
  __private: { normalizeVersionSeparators }
} = require('../model-usage-identity');
const {
  PRICING_RESOLUTION_STATUS,
  isKnownZeroPricing
} = require('../model-pricing-resolver');

const MODELS_DEV_PRICING_PROVIDER_ID = 'models.dev';
const PRICING_INDEX_CACHE = new WeakMap();

function normalizeText(value) {
  return String(value || '').trim();
}

function unique(items = []) {
  return Array.from(new Set(items.map(normalizeText).filter(Boolean)));
}

function buildPricingIndex(pricingByModel) {
  if (
    pricingByModel
    && (typeof pricingByModel === 'object' || typeof pricingByModel === 'function')
    && PRICING_INDEX_CACHE.has(pricingByModel)
  ) {
    return PRICING_INDEX_CACHE.get(pricingByModel);
  }
  const index = new Map();
  Object.entries(pricingByModel && typeof pricingByModel === 'object' ? pricingByModel : {})
    .forEach(([model, pricing]) => {
      const key = normalizeText(model).toLowerCase();
      if (key && pricing && typeof pricing === 'object' && !index.has(key)) {
        index.set(key, pricing);
      }
    });
  if (pricingByModel && (typeof pricingByModel === 'object' || typeof pricingByModel === 'function')) {
    PRICING_INDEX_CACHE.set(pricingByModel, index);
  }
  return index;
}

function expandModelIds(modelIds, catalogProviderIds) {
  const expanded = [];
  unique(modelIds).forEach((modelId) => {
    expanded.push(modelId, normalizeVersionSeparators(modelId));
    const slash = modelId.indexOf('/');
    if (slash > 0) {
      const prefix = modelId.slice(0, slash).toLowerCase();
      const remainder = modelId.slice(slash + 1);
      if (!catalogProviderIds.has(prefix)) {
        expanded.push(remainder, normalizeVersionSeparators(remainder));
      }
    }
  });
  return unique(expanded);
}

function createModelsDevPricingProvider(options = {}) {
  let catalogProviderIds = new Set();
  let snapshot = null;

  function loadSnapshot(loadOptions = {}) {
    const loaded = loadModelsDevCatalog({
      ...options,
      forceReload: loadOptions.forceReload === true
    });
    const catalog = loaded && loaded.catalog;
    catalogProviderIds = new Set(
      Object.keys(catalog && catalog.providers || {}).map((id) => id.toLowerCase())
    );
    const records = catalog
      ? buildModelsDevPricingRecords({ modelsDevCatalog: catalog })
      : [];
    const fingerprint = fingerprintPricingCatalog(records);
    snapshot = {
      providerId: MODELS_DEV_PRICING_PROVIDER_ID,
      fingerprint,
      revision: fingerprint,
      records
    };
    return snapshot;
  }

  function resolve(input = {}, context = {}) {
    const pricingIndex = buildPricingIndex(context.pricingByModel);
    if (pricingIndex.size === 0) return { status: PRICING_RESOLUTION_STATUS.UNKNOWN };

    const identity = resolveBillingIdentity(input.model, input.provider);
    const modelIds = expandModelIds(identity.modelIds, catalogProviderIds);
    const candidateKeys = [];

    identity.providerPrefixes.forEach((prefix) => {
      modelIds.forEach((modelId) => candidateKeys.push(`${prefix}${modelId}`));
    });
    modelIds.forEach((modelId) => {
      inferModelsDevProviderIds(identity.executionProvider || input.provider, modelId)
        .forEach((providerId) => candidateKeys.push(`${providerId}/${modelId}`));
      inferBaseModelIds(modelId).forEach((baseModelId) => candidateKeys.push(baseModelId));
      if (modelId.includes('/')) candidateKeys.push(modelId);
    });

    for (const candidate of unique(candidateKeys)) {
      const pricing = pricingIndex.get(candidate.toLowerCase());
      if (!pricing) continue;
      return {
        status: isKnownZeroPricing(pricing)
          ? PRICING_RESOLUTION_STATUS.KNOWN_ZERO
          : PRICING_RESOLUTION_STATUS.PRICED,
        matchedModel: normalizeText(pricing.model || candidate),
        matchType: 'models_dev_identity',
        pricing
      };
    }
    return { status: PRICING_RESOLUTION_STATUS.UNKNOWN };
  }

  return {
    id: MODELS_DEV_PRICING_PROVIDER_ID,
    loadSnapshot,
    resolve,
    getSnapshot: () => snapshot
  };
}

module.exports = {
  MODELS_DEV_PRICING_PROVIDER_ID,
  createModelsDevPricingProvider
};
