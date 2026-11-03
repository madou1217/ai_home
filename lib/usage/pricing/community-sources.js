'use strict';

// LiteLLM / OpenRouter 社区价格兜底。
//
// 它们只在官方源缺失时参与维度级合并（authority 20），且与官方源一样必须经过
// 快照 + 人工复核，不能直接把刚抓到的价格用于计费。解析器是固定 URL + 固定格式：
// 不提供通用爬虫入口，避免价格变成不可复核的搜索结果。

const { createPriceQuote, PRICE_SOURCE_KIND } = require('./price-quote');

const COMMUNITY_PRICING_SOURCES = Object.freeze([
  Object.freeze({
    id: 'community:litellm',
    name: 'LiteLLM',
    kind: PRICE_SOURCE_KIND.COMMUNITY,
    url: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
    license: 'MIT',
    parser: 'litellm'
  }),
  Object.freeze({
    id: 'community:openrouter',
    name: 'OpenRouter',
    kind: PRICE_SOURCE_KIND.COMMUNITY,
    url: 'https://openrouter.ai/api/v1/models',
    license: 'OpenRouter terms',
    parser: 'openrouter'
  })
]);

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function toPerMillion(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Number((number * 1_000_000).toFixed(12)) : null;
}

function providerAndModel(rawModel, declaredProvider) {
  const raw = normalizeText(rawModel);
  if (!raw) return null;
  const slash = raw.indexOf('/');
  const provider = normalizeText(declaredProvider).toLowerCase()
    || (slash > 0 ? raw.slice(0, slash).toLowerCase() : 'community');
  const model = slash > 0 ? raw.slice(slash + 1) : raw;
  return { provider, model };
}

function parseLiteLlm(payload) {
  const quotes = [];
  for (const [rawModel, value] of Object.entries(payload && typeof payload === 'object' ? payload : {})) {
    if (!value || typeof value !== 'object') continue;
    const identity = providerAndModel(rawModel, value.litellm_provider);
    if (!identity) continue;
    const input = toPerMillion(value.input_cost_per_token);
    const output = toPerMillion(value.output_cost_per_token);
    const cacheRead = toPerMillion(value.cache_read_input_token_cost);
    const cacheWrite = toPerMillion(value.cache_creation_input_token_cost);
    if ([input, output, cacheRead, cacheWrite].every((item) => item === null)) continue;
    try {
      quotes.push(createPriceQuote({
        provider: identity.provider,
        model: identity.model,
        input,
        output,
        cacheRead,
        cacheWrite,
        cacheWrite1h: null,
        reasoning: toPerMillion(value.reasoning_output_token_cost),
        source: {
          id: 'community:litellm',
          kind: PRICE_SOURCE_KIND.COMMUNITY,
          authority: 20,
          confidence: 0.45,
          url: COMMUNITY_PRICING_SOURCES[0].url,
          license: COMMUNITY_PRICING_SOURCES[0].license
        }
      }));
    } catch (_error) { /* 单条坏数据跳过 */ }
  }
  return quotes;
}

function parseOpenRouter(payload) {
  const quotes = [];
  const models = Array.isArray(payload && payload.data) ? payload.data : [];
  for (const model of models) {
    const identity = providerAndModel(model && model.id);
    const pricing = model && model.pricing;
    if (!identity || !pricing) continue;
    const input = toPerMillion(pricing.prompt);
    const output = toPerMillion(pricing.completion);
    const cacheRead = toPerMillion(pricing.input_cache_read);
    const cacheWrite = toPerMillion(pricing.input_cache_write);
    if ([input, output, cacheRead, cacheWrite].every((item) => item === null)) continue;
    try {
      quotes.push(createPriceQuote({
        provider: identity.provider,
        model: identity.model,
        input,
        output,
        cacheRead,
        cacheWrite,
        cacheWrite1h: null,
        reasoning: toPerMillion(pricing.internal_reasoning),
        source: {
          id: 'community:openrouter',
          kind: PRICE_SOURCE_KIND.COMMUNITY,
          authority: 20,
          confidence: 0.4,
          url: COMMUNITY_PRICING_SOURCES[1].url,
          license: COMMUNITY_PRICING_SOURCES[1].license
        }
      }));
    } catch (_error) { /* 单条坏数据跳过 */ }
  }
  return quotes;
}

function parseCommunityPayload(parser, payload) {
  if (parser === 'litellm') return parseLiteLlm(payload);
  if (parser === 'openrouter') return parseOpenRouter(payload);
  throw new Error('community_pricing_parser_unknown');
}

async function fetchCommunitySource(source, options = {}) {
  const fetchImpl = options.fetchImpl;
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');
  const timeoutMs = Math.max(1000, Math.min(60_000, Number(options.timeoutMs) || 20_000));
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(source.url, {
      headers: { 'user-agent': 'aih-pricing/1.0', accept: 'application/json' },
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!response || !response.ok) throw new Error(`http_${response ? response.status : 'unknown'}`);
    const payload = await response.json();
    const quotes = parseCommunityPayload(source.parser, payload);
    return { quotes, fetchedAt: new Date(options.now ? options.now() : Date.now()).toISOString() };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function refreshCommunitySource(sourceId, options = {}) {
  const source = COMMUNITY_PRICING_SOURCES.find((item) => item.id === sourceId);
  if (!source) throw new Error('community_pricing_source_unknown');
  const store = options.store;
  if (!store) throw new Error('pricing_source_store_unavailable');
  const fetched = await fetchCommunitySource(source, options);
  return {
    sourceId: source.id,
    ...store.applySnapshot({
      sourceId: source.id,
      source: {
        id: source.id,
        kind: source.kind,
        url: source.url,
        license: source.license,
        fetchedAt: fetched.fetchedAt
      },
      quotes: fetched.quotes,
      fetchedAt: fetched.fetchedAt,
      requireReview: options.requireReview !== false
    }),
    quoteCount: fetched.quotes.length
  };
}

async function refreshCommunitySources(options = {}) {
  const results = [];
  for (const source of COMMUNITY_PRICING_SOURCES) {
    try {
      results.push(await refreshCommunitySource(source.id, options));
    } catch (error) {
      results.push({ sourceId: source.id, ok: false, error: error && error.message || 'refresh_failed' });
    }
  }
  return results;
}

module.exports = {
  COMMUNITY_PRICING_SOURCES,
  fetchCommunitySource,
  parseCommunityPayload,
  parseLiteLlm,
  parseOpenRouter,
  refreshCommunitySource,
  refreshCommunitySources
};
