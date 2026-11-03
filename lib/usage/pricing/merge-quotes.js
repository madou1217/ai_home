'use strict';

const {
  PRICE_QUOTE_CURRENCY,
  PRICE_QUOTE_DIMENSIONS,
  PRICE_QUOTE_SCHEMA_VERSION,
  PRICE_QUOTE_STATUS,
  PRICE_QUOTE_UNIT,
  createPriceQuote
} = require('./price-quote');

function normalizeText(value) {
  return String(value || '').trim();
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function timestamp(value) {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function quoteStale(quote, now) {
  if (quote.source && quote.source.stale === true) return true;
  const expiresAt = timestamp(quote.source && quote.source.expiresAt);
  return expiresAt > 0 && expiresAt < now;
}

function rankQuote(quote, accountRef, now) {
  const accountMatch = accountRef && quote.accountRef === accountRef ? 1 : 0;
  const authority = Number(quote.source && quote.source.authority) || 0;
  const specificity = quote.derived ? Math.min(1, Number(quote.specificity) || 0) : Number(quote.specificity) || 0;
  const freshness = quoteStale(quote, now) ? 0 : 1;
  const fetchedAt = timestamp(quote.source && quote.source.fetchedAt);
  const confidence = Number(quote.source && quote.source.confidence) || 0;
  return [accountMatch, authority, specificity, freshness, fetchedAt, confidence];
}

function compareRank(left, right) {
  const leftRank = left.rank;
  const rightRank = right.rank;
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] !== rightRank[index]) return rightRank[index] - leftRank[index];
  }
  return String(left.quote.source && left.quote.source.id || '')
    .localeCompare(String(right.quote.source && right.quote.source.id || ''));
}

function createUnknownPriceQuote(options = {}) {
  return Object.freeze({
    schemaVersion: PRICE_QUOTE_SCHEMA_VERSION,
    provider: normalizeText(options.provider),
    model: normalizeText(options.model),
    currency: PRICE_QUOTE_CURRENCY,
    unit: PRICE_QUOTE_UNIT,
    status: PRICE_QUOTE_STATUS.UNKNOWN,
    ...Object.fromEntries(PRICE_QUOTE_DIMENSIONS.map((dimension) => [dimension, null])),
    source: null,
    sources: Object.freeze([]),
    stale: false,
    derived: false,
    warnings: Object.freeze([])
  });
}

function mergeDimensions(sorted, now) {
  const picked = {};
  const pickedByDimension = {};
  const warnings = [];
  PRICE_QUOTE_DIMENSIONS.forEach((dimension) => {
    const candidates = sorted.filter((entry) => entry.quote[dimension] !== null && entry.quote[dimension] !== undefined);
    if (candidates.length < 1) {
      picked[dimension] = null;
      return;
    }
    const winner = candidates[0];
    picked[dimension] = winner.quote[dimension];
    pickedByDimension[dimension] = winner.quote;
    const rejected = candidates.slice(1)
      .filter((entry) => Number(entry.quote[dimension]) !== Number(winner.quote[dimension]))
      .map((entry) => ({
        sourceId: entry.quote.source && entry.quote.source.id,
        authority: entry.quote.source && entry.quote.source.authority,
        value: entry.quote[dimension]
      }));
    if (rejected.length > 0) {
      warnings.push(Object.freeze({
        code: 'price_conflict',
        dimension,
        chosen: {
          sourceId: winner.quote.source && winner.quote.source.id,
          authority: winner.quote.source && winner.quote.source.authority,
          value: winner.quote[dimension]
        },
        rejected: Object.freeze(rejected)
      }));
    }
    if (quoteStale(winner.quote, now)) {
      warnings.push(Object.freeze({
        code: 'price_source_stale',
        dimension,
        sourceId: winner.quote.source && winner.quote.source.id,
        fetchedAt: winner.quote.source && winner.quote.source.fetchedAt
      }));
    }
  });
  return { picked, pickedByDimension, warnings };
}

function mergeTiers(sorted) {
  const source = sorted.find((entry) => Array.isArray(entry.quote.tiers) && entry.quote.tiers.length > 0);
  if (!source) return null;
  return {
    tiers: source.quote.tiers,
    sourceId: source.quote.source && source.quote.source.id
  };
}

/**
 * 宿主合并策略（纯函数）：
 *   账号/人工 override（宿主） > accountRef 精确匹配 > authority > specificity
 *   > 新鲜度 > fetchedAt > confidence。
 *
 * 每个维度独立裁决：某个来源缺 cacheWrite1h 不会把另一个来源的 cacheWrite1h
 * 一并抹掉；所有来源都没有的维度保持 null（unknown），绝不以 0 兜底。
 */
function mergePriceQuotes(input, options = {}) {
  const sourceQuotes = Array.isArray(input)
    ? input
    : (isRecord(input) && Array.isArray(input.quotes) ? input.quotes : []);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const accountRef = normalizeText(options.accountRef);
  const normalized = [];

  sourceQuotes.forEach((raw) => {
    if (!isRecord(raw)) return;
    let quote;
    try {
      quote = createPriceQuote(raw);
    } catch (_error) {
      // 插件给坏数据时宿主不使用它；collect 的 attempts / report 负责可观察性。
      return;
    }
    if (quote.accountRef && quote.accountRef !== accountRef) return;
    if (quote.effectiveAt && timestamp(quote.effectiveAt) > now) return;
    normalized.push(quote);
  });

  const overrideInput = options.hostOverride;
  if (overrideInput) {
    (Array.isArray(overrideInput) ? overrideInput : [overrideInput]).forEach((raw) => {
      if (!isRecord(raw)) return;
      const override = createPriceQuote({
        provider: options.provider || raw.provider || '',
        model: options.model || raw.model || '',
        ...raw,
        source: raw.source || { id: 'host-override', kind: 'account', authority: 100, confidence: 1 }
      });
      normalized.push(override);
    });
  }

  if (normalized.length < 1) {
    return createUnknownPriceQuote({ provider: options.provider, model: options.model });
  }

  const sorted = normalized
    .filter((quote) => quote.status !== PRICE_QUOTE_STATUS.UNKNOWN)
    .map((quote) => ({ quote, rank: rankQuote(quote, accountRef, now) }))
    .sort(compareRank);

  if (sorted.length < 1) {
    return createUnknownPriceQuote({ provider: options.provider, model: options.model });
  }

  const { picked, pickedByDimension, warnings } = mergeDimensions(sorted, now);
  const values = PRICE_QUOTE_DIMENSIONS
    .map((dimension) => picked[dimension])
    .filter((value) => value !== null && value !== undefined);
  const tierResult = mergeTiers(sorted);
  if (tierResult) {
    tierResult.tiers.forEach((tier) => {
      PRICE_QUOTE_DIMENSIONS.forEach((dimension) => {
        if (tier[dimension] !== null && tier[dimension] !== undefined) values.push(tier[dimension]);
      });
    });
  }

  const primary = sorted[0].quote;
  const derivedQuote = Object.values(pickedByDimension)
    .find((quote) => quote.derived === true);
  const sourceIds = Array.from(new Set(sorted.map((entry) => entry.quote.source && entry.quote.source.id).filter(Boolean)));
  const status = values.length < 1
    ? PRICE_QUOTE_STATUS.UNKNOWN
    : values.every((value) => Number(value) === 0)
      ? PRICE_QUOTE_STATUS.FREE
      : PRICE_QUOTE_STATUS.PRICED;

  return Object.freeze({
    schemaVersion: PRICE_QUOTE_SCHEMA_VERSION,
    provider: options.provider || primary.provider,
    model: options.model || primary.model,
    currency: PRICE_QUOTE_CURRENCY,
    unit: PRICE_QUOTE_UNIT,
    status,
    ...picked,
    ...(tierResult ? { tiers: tierResult.tiers } : {}),
    source: primary.source,
    sources: Object.freeze(sourceIds),
    stale: quoteStale(primary, now)
      || Object.values(pickedByDimension).some((quote) => quoteStale(quote, now)),
    derived: Boolean(derivedQuote),
    ...(derivedQuote && derivedQuote.derivedFrom ? { derivedFrom: derivedQuote.derivedFrom } : {}),
    warnings: Object.freeze(warnings)
  });
}

module.exports = {
  createUnknownPriceQuote,
  mergePriceQuotes,
  quoteStale,
  rankQuote
};
