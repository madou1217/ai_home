'use strict';

const {
  buildModelsDevPricingRecords,
  __private: { loadModelsDevCatalog }
} = require('../../../server/models-dev-metadata');
const {
  createModelsDevSource,
  quoteFromModelsDevRecord
} = require('../price-quote');

const MODELS_DEV_SOURCE_ID = 'models.dev';

function quoteKey(quote) {
  return `${String(quote.provider || '').toLowerCase()}\u0000${String(quote.model || '').toLowerCase()}`;
}

/**
 * 内置 `pricing.catalog` 适配器：models.dev 只提供数据，不参与最终裁决。
 * 返回的每条 quote 都带 source/authority/fetchedAt，宿主用 merge-quotes 合并。
 */
function createModelsDevCatalogSource(options = {}) {
  const loaded = loadModelsDevCatalog(options);
  if (!loaded) {
    return {
      id: MODELS_DEV_SOURCE_ID,
      capability: 'pricing.catalog',
      generatedAt: '',
      source: createModelsDevSource({ url: options.url, fetchedAt: options.fetchedAt }),
      quotes: [],
      byKey: new Map()
    };
  }

  const source = createModelsDevSource({
    url: loaded.url,
    fetchedAt: loaded.generatedAt || options.fetchedAt,
    stale: options.stale
  });
  const records = buildModelsDevPricingRecords({ modelsDevCatalog: loaded.catalog });
  const quotes = records
    .map((record) => quoteFromModelsDevRecord(record, source))
    .filter((quote) => quote.status !== 'unknown');
  const byKey = new Map();
  quotes.forEach((quote) => {
    const key = quoteKey(quote);
    if (!byKey.has(key)) byKey.set(key, quote);
  });

  return {
    id: MODELS_DEV_SOURCE_ID,
    capability: 'pricing.catalog',
    generatedAt: loaded.generatedAt || '',
    source,
    quotes,
    byKey
  };
}

function loadModelsDevPriceQuotes(options = {}) {
  return createModelsDevCatalogSource(options).quotes;
}

module.exports = {
  MODELS_DEV_SOURCE_ID,
  createModelsDevCatalogSource,
  loadModelsDevPriceQuotes,
  quoteKey
};
