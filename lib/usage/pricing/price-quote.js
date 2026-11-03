'use strict';

// PriceQuote 是宿主与价格插件之间的值对象：插件只提供“某来源对某模型的报价”，
// 合并、账号覆盖和最终计费口径全部由宿主决定。单位固定为 USD / 每百万 token，
// 避免插件把 per-token / per-1K / 包月价混进同一条链路。

const PRICE_QUOTE_SCHEMA_VERSION = 1;
const PRICE_QUOTE_CURRENCY = 'USD';
const PRICE_QUOTE_UNIT = 'per_1m_tokens';

const PRICE_QUOTE_STATUS = Object.freeze({
  PRICED: 'priced',
  FREE: 'free',
  UNKNOWN: 'unknown'
});

const PRICE_QUOTE_DIMENSIONS = Object.freeze([
  'input',
  'output',
  'cacheRead',
  'cacheWrite',
  'cacheWrite1h',
  'reasoning'
]);

const PRICE_SOURCE_KIND = Object.freeze({
  ACCOUNT: 'account',
  MANUAL: 'manual',
  OFFICIAL: 'official',
  VENDOR: 'vendor',
  PROVIDER: 'provider',
  AGGREGATOR: 'aggregator',
  COMMUNITY: 'community',
  DERIVED: 'derived',
  UNKNOWN: 'unknown'
});

// 宿主裁决顺序：账号自定义价 > 人工覆盖 > 官方 > 厂商机读目录 > Provider 专属目录
// > 聚合目录（models.dev） > 社区 > 派生。插件提供的 authority 只能影响同层排序，
// 不能越过宿主 override。
const PRICE_SOURCE_AUTHORITY = Object.freeze({
  [PRICE_SOURCE_KIND.ACCOUNT]: 100,
  [PRICE_SOURCE_KIND.MANUAL]: 95,
  [PRICE_SOURCE_KIND.OFFICIAL]: 90,
  [PRICE_SOURCE_KIND.VENDOR]: 80,
  [PRICE_SOURCE_KIND.PROVIDER]: 60,
  [PRICE_SOURCE_KIND.AGGREGATOR]: 40,
  [PRICE_SOURCE_KIND.COMMUNITY]: 20,
  [PRICE_SOURCE_KIND.DERIVED]: 10,
  [PRICE_SOURCE_KIND.UNKNOWN]: 0
});

const PRICING_SNAPSHOT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function normalizeText(value) {
  return String(value || '').trim();
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function roundPrice(value) {
  if (value === null) return null;
  return Number(Number(value).toFixed(12));
}

function normalizeNumber(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError(`price_quote_invalid_${field}`);
  }
  return roundPrice(number);
}

function normalizeTimestamp(value, field) {
  const text = normalizeText(value);
  if (!text) return '';
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw new TypeError(`price_quote_invalid_${field}`);
  return new Date(parsed).toISOString();
}

function normalizeSourceKind(value) {
  const kind = normalizeText(value).toLowerCase();
  return Object.values(PRICE_SOURCE_KIND).includes(kind) ? kind : PRICE_SOURCE_KIND.UNKNOWN;
}

function normalizeSource(input) {
  const source = typeof input === 'string' ? { id: input } : (isRecord(input) ? input : {});
  const kind = normalizeSourceKind(source.kind);
  const kindAuthority = PRICE_SOURCE_AUTHORITY[kind];
  // authority 由宿主按来源类型封顶：插件可以声明更低的可信度，但不能把
  // 聚合目录自封成官方源。账号/人工覆盖只由宿主自己构造。
  const authority = source.authority === undefined || source.authority === null
    ? kindAuthority
    : Math.min(kindAuthority, normalizeNumber(source.authority, 'source_authority') ?? 0);
  const confidence = source.confidence === undefined || source.confidence === null
    ? 0.5
    : Math.max(0, Math.min(1, normalizeNumber(source.confidence, 'source_confidence')));
  return Object.freeze({
    id: normalizeText(source.id) || 'unknown',
    kind,
    authority: Math.min(100, Math.max(0, authority)),
    confidence,
    ...(normalizeText(source.url) ? { url: normalizeText(source.url) } : {}),
    ...(normalizeText(source.license) ? { license: normalizeText(source.license) } : {}),
    ...(normalizeTimestamp(source.fetchedAt, 'source_fetched_at') ? {
      fetchedAt: normalizeTimestamp(source.fetchedAt, 'source_fetched_at')
    } : {}),
    ...(normalizeTimestamp(source.expiresAt, 'source_expires_at') ? {
      expiresAt: normalizeTimestamp(source.expiresAt, 'source_expires_at')
    } : {}),
    ...(source.stale === true ? { stale: true } : {})
  });
}

function normalizeTier(input) {
  if (!isRecord(input)) throw new TypeError('price_quote_invalid_tier');
  const when = isRecord(input.when) ? input.when : {};
  const contextTokensGt = normalizeNumber(when.contextTokensGt, 'tier_context_tokens_gt');
  if (contextTokensGt === null) throw new TypeError('price_quote_invalid_tier_when');
  const tier = {
    when: { contextTokensGt },
    ...Object.fromEntries(PRICE_QUOTE_DIMENSIONS
      .map((dimension) => {
        const value = normalizeNumber(input[dimension], `tier_${dimension}`);
        return value === null ? null : [dimension, value];
      })
      .filter(Boolean))
  };
  return Object.freeze({ ...tier, when: Object.freeze(tier.when) });
}

function collectPriceValues(quote) {
  const values = PRICE_QUOTE_DIMENSIONS
    .map((dimension) => quote[dimension])
    .filter((value) => value !== null && value !== undefined);
  const tiers = Array.isArray(quote.tiers) ? quote.tiers : [];
  tiers.forEach((tier) => {
    PRICE_QUOTE_DIMENSIONS.forEach((dimension) => {
      if (tier[dimension] !== null && tier[dimension] !== undefined) values.push(tier[dimension]);
    });
  });
  return values;
}

function deriveStatus(quote) {
  const values = collectPriceValues(quote);
  if (values.length < 1) return PRICE_QUOTE_STATUS.UNKNOWN;
  return values.every((value) => Number(value) === 0)
    ? PRICE_QUOTE_STATUS.FREE
    : PRICE_QUOTE_STATUS.PRICED;
}

/**
 * 规范化一条价格报价。非法数值（负数、NaN、Infinity）直接抛错：价格是计费事实，
 * 不能把坏数据静默当成 unknown 或 0。
 */
function createPriceQuote(input = {}) {
  if (!isRecord(input)) throw new TypeError('price_quote_invalid');
  const provider = normalizeText(input.provider);
  const model = normalizeText(input.model);
  if (!provider) throw new TypeError('price_quote_invalid_provider');
  if (!model) throw new TypeError('price_quote_invalid_model');
  if (input.currency && normalizeText(input.currency).toUpperCase() !== PRICE_QUOTE_CURRENCY) {
    throw new TypeError('price_quote_invalid_currency');
  }
  if (input.unit && normalizeText(input.unit) !== PRICE_QUOTE_UNIT) {
    throw new TypeError('price_quote_invalid_unit');
  }

  const dimensions = {};
  PRICE_QUOTE_DIMENSIONS.forEach((dimension) => {
    dimensions[dimension] = normalizeNumber(input[dimension], dimension);
  });
  const tiers = (Array.isArray(input.tiers) ? input.tiers : [])
    .map(normalizeTier)
    .sort((left, right) => left.when.contextTokensGt - right.when.contextTokensGt);

  const quote = {
    schemaVersion: PRICE_QUOTE_SCHEMA_VERSION,
    provider,
    model,
    ...(normalizeText(input.accountRef) ? { accountRef: normalizeText(input.accountRef) } : {}),
    currency: PRICE_QUOTE_CURRENCY,
    unit: PRICE_QUOTE_UNIT,
    ...dimensions,
    ...(tiers.length > 0 ? { tiers: Object.freeze(tiers) } : {}),
    source: normalizeSource(input.source),
    specificity: normalizeNumber(input.specificity, 'specificity') ?? 2,
    derived: input.derived === true,
    ...(normalizeText(input.derivedFrom) ? { derivedFrom: normalizeText(input.derivedFrom) } : {}),
    ...(normalizeTimestamp(input.effectiveAt, 'effective_at') ? {
      effectiveAt: normalizeTimestamp(input.effectiveAt, 'effective_at')
    } : {}),
    ...(Array.isArray(input.warnings) && input.warnings.length > 0
      ? { warnings: Object.freeze(input.warnings.map((warning) => Object.freeze({ ...warning }))) }
      : {})
  };
  quote.status = deriveStatus(quote);
  return Object.freeze(quote);
}

function perTokenToPerMillion(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return roundPrice(number * 1_000_000);
}

function modelsDevQuoteSource(source = {}) {
  const fetchedAt = normalizeText(source.fetchedAt);
  const stale = source.stale === true
    || (fetchedAt ? isPricingSnapshotStale(fetchedAt) : true);
  return Object.freeze({
    id: 'models.dev',
    kind: PRICE_SOURCE_KIND.AGGREGATOR,
    authority: PRICE_SOURCE_AUTHORITY[PRICE_SOURCE_KIND.AGGREGATOR],
    confidence: 0.8,
    url: normalizeText(source.url) || 'https://models.dev/catalog.json',
    license: 'MIT',
    ...(fetchedAt ? { fetchedAt } : {}),
    ...(stale ? { stale: true } : {})
  });
}

/** 把 models.dev 的 per-token 记录转成统一的 per-1M PriceQuote。 */
function quoteFromModelsDevRecord(record, source = {}) {
  if (!isRecord(record)) throw new TypeError('price_quote_invalid_models_dev_record');
  const catalogModel = normalizeText(record.model);
  const slash = catalogModel.indexOf('/');
  if (slash < 1 || slash === catalogModel.length - 1) {
    throw new TypeError('price_quote_invalid_models_dev_model');
  }
  const provider = catalogModel.slice(0, slash);
  const model = catalogModel.slice(slash + 1);
  const tiers = (Array.isArray(record.contextCostTiers) ? record.contextCostTiers : [])
    .map((tier) => {
      const when = isRecord(tier && tier.tier) ? tier.tier : { size: tier && tier.size };
      return {
        when: { contextTokensGt: when.size },
        input: perTokenToPerMillion(tier && tier.inputCostPerToken),
        output: perTokenToPerMillion(tier && tier.outputCostPerToken),
        cacheRead: perTokenToPerMillion(tier && tier.cacheReadInputTokenCost),
        cacheWrite: perTokenToPerMillion(tier && tier.cacheCreationInputTokenCost),
        cacheWrite1h: null,
        reasoning: perTokenToPerMillion(tier && tier.reasoningOutputTokenCost)
      };
    })
    .filter((tier) => Number.isFinite(Number(tier.when.contextTokensGt)));

  return createPriceQuote({
    provider,
    model,
    input: perTokenToPerMillion(record.inputCostPerToken),
    output: perTokenToPerMillion(record.outputCostPerToken),
    cacheRead: perTokenToPerMillion(record.cacheReadInputTokenCost),
    cacheWrite: perTokenToPerMillion(record.cacheCreationInputTokenCost),
    cacheWrite1h: null,
    reasoning: perTokenToPerMillion(record.reasoningOutputTokenCost),
    tiers,
    source: modelsDevQuoteSource(source)
  });
}

function isPricingSnapshotStale(fetchedAt, now = Date.now()) {
  const timestamp = Date.parse(normalizeText(fetchedAt));
  if (!Number.isFinite(timestamp)) return true;
  return now - timestamp > PRICING_SNAPSHOT_MAX_AGE_MS;
}

module.exports = {
  PRICE_QUOTE_CURRENCY,
  PRICE_QUOTE_DIMENSIONS,
  PRICE_QUOTE_SCHEMA_VERSION,
  PRICE_QUOTE_STATUS,
  PRICE_QUOTE_UNIT,
  PRICE_SOURCE_AUTHORITY,
  PRICE_SOURCE_KIND,
  PRICING_SNAPSHOT_MAX_AGE_MS,
  createPriceQuote,
  createModelsDevSource: modelsDevQuoteSource,
  isPricingSnapshotStale,
  quoteFromModelsDevRecord
};
