'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PRICE_SOURCE_AUTHORITY,
  createPriceQuote,
  quoteFromModelsDevRecord
} = require('../lib/usage/pricing/price-quote');
const { mergePriceQuotes } = require('../lib/usage/pricing/merge-quotes');
const {
  loadModelsDevPriceQuotes,
  quoteKey
} = require('../lib/usage/pricing/catalog-sources/models-dev');

const FETCHED_AT = '2026-10-19T05:32:55.764Z';
const NOW = Date.parse('2026-10-20T00:00:00.000Z');

test('models.dev records are converted to per-1M USD quotes without losing tiers', () => {
  const quote = quoteFromModelsDevRecord({
    model: 'openai/gpt-6.1-sol',
    inputCostPerToken: 0.000002,
    outputCostPerToken: 0.00001,
    cacheReadInputTokenCost: 0.0000001,
    cacheCreationInputTokenCost: 0.0000025,
    contextCostTiers: [{
      size: 272000,
      inputCostPerToken: 0.000004,
      outputCostPerToken: 0.000015,
      cacheReadInputTokenCost: 0.0000002,
      cacheCreationInputTokenCost: 0.000005
    }]
  }, { fetchedAt: FETCHED_AT });

  assert.equal(quote.provider, 'openai');
  assert.equal(quote.model, 'gpt-6.1-sol');
  assert.equal(quote.input, 2);
  assert.equal(quote.output, 10);
  assert.equal(quote.cacheRead, 0.1);
  assert.equal(quote.cacheWrite, 2.5);
  assert.equal(quote.cacheWrite1h, null);
  assert.equal(quote.tiers[0].when.contextTokensGt, 272000);
  assert.equal(quote.tiers[0].input, 4);
  assert.equal(quote.source.kind, 'aggregator');
  assert.equal(quote.source.authority, PRICE_SOURCE_AUTHORITY.aggregator);
  assert.equal(quote.status, 'priced');
});

test('a quote with only declared zero values is free, while an empty quote is unknown', () => {
  const free = createPriceQuote({
    provider: 'kimi',
    model: 'k3',
    input: 0,
    output: 0,
    source: { id: 'models.dev', kind: 'aggregator' }
  });
  assert.equal(free.status, 'free');

  const unknown = createPriceQuote({
    provider: 'kimi',
    model: 'unknown',
    source: { id: 'models.dev', kind: 'aggregator' }
  });
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.input, null);
});

test('source authority is capped by source kind, so an aggregator cannot self-promote', () => {
  const quote = createPriceQuote({
    provider: 'openai',
    model: 'gpt',
    input: 1,
    source: { id: 'self-promoted', kind: 'aggregator', authority: 100 }
  });
  assert.equal(quote.source.authority, PRICE_SOURCE_AUTHORITY.aggregator);
});

test('invalid negative prices fail closed instead of becoming zero', () => {
  assert.throws(() => createPriceQuote({
    provider: 'openai',
    model: 'gpt',
    input: -1,
    source: { id: 'models.dev', kind: 'aggregator' }
  }), /price_quote_invalid_input/);
});

test('host merge chooses official over aggregator and keeps missing dimensions unknown', () => {
  const aggregator = createPriceQuote({
    provider: 'openai',
    model: 'gpt-6.1-sol',
    input: 2,
    output: 10,
    cacheRead: 0.1,
    source: { id: 'models.dev', kind: 'aggregator', fetchedAt: FETCHED_AT }
  });
  const official = createPriceQuote({
    provider: 'openai',
    model: 'gpt-6.1-sol',
    input: 2.1,
    output: 10.5,
    source: { id: 'openai', kind: 'official', fetchedAt: FETCHED_AT }
  });

  const merged = mergePriceQuotes([aggregator, official], {
    provider: 'openai',
    model: 'gpt-6.1-sol',
    now: NOW
  });

  assert.equal(merged.status, 'priced');
  assert.equal(merged.input, 2.1);
  assert.equal(merged.output, 10.5);
  assert.equal(merged.cacheRead, 0.1);
  assert.equal(merged.cacheWrite1h, null);
  assert.equal(merged.source.id, 'openai');
  assert.ok(merged.warnings.some((warning) => warning.code === 'price_conflict' && warning.dimension === 'input'));
  assert.ok(merged.sources.includes('openai'));
  assert.ok(merged.sources.includes('models.dev'));
});

test('account override wins over all plugin quotes and account-scoped quotes do not leak', () => {
  const shared = createPriceQuote({
    provider: 'openai',
    model: 'gpt-6.1-sol',
    input: 2,
    output: 10,
    source: { id: 'models.dev', kind: 'aggregator', fetchedAt: FETCHED_AT }
  });
  const otherAccount = createPriceQuote({
    provider: 'openai',
    model: 'gpt-6.1-sol',
    accountRef: 'other-account',
    input: 0.1,
    source: { id: 'account-other', kind: 'account', authority: 100, fetchedAt: FETCHED_AT }
  });
  const merged = mergePriceQuotes([shared, otherAccount], {
    provider: 'openai',
    model: 'gpt-6.1-sol',
    accountRef: 'target-account',
    now: NOW,
    hostOverride: {
      input: 1,
      source: { id: 'account-custom', kind: 'account', fetchedAt: FETCHED_AT }
    }
  });

  assert.equal(merged.input, 1);
  assert.equal(merged.output, 10);
  assert.equal(merged.source.id, 'account-custom');
  assert.ok(!merged.sources.includes('account-other'));
});

test('derived and stale quotes stay visible but carry provenance', () => {
  const base = createPriceQuote({
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    cacheWrite: 6.25,
    derived: true,
    derivedFrom: 'anthropic/claude-opus-4-6',
    source: {
      id: 'models.dev',
      kind: 'aggregator',
      fetchedAt: '2026-09-01T00:00:00.000Z',
      expiresAt: '2026-09-15T00:00:00.000Z'
    }
  });
  const merged = mergePriceQuotes([base], {
    provider: 'anthropic',
    model: 'claude-opus-4-6-thinking',
    now: NOW
  });

  assert.equal(merged.cacheWrite, 6.25);
  assert.equal(merged.derived, true);
  assert.equal(merged.derivedFrom, 'anthropic/claude-opus-4-6');
  assert.equal(merged.stale, true);
  assert.ok(merged.warnings.some((warning) => warning.code === 'price_source_stale'));
});

test('no quotes returns an explicit unknown result rather than zero prices', () => {
  const merged = mergePriceQuotes([], { provider: 'openai', model: 'missing' });
  assert.equal(merged.status, 'unknown');
  assert.equal(merged.input, null);
  assert.equal(merged.output, null);
  assert.equal(merged.cacheRead, null);
  assert.deepEqual(merged.sources, []);
});

test('built-in models.dev catalog source exposes indexed PriceQuotes', () => {
  const source = loadModelsDevPriceQuotes();
  assert.ok(source.length > 0);
  const gpt = source.find((quote) => quoteKey(quote) === 'openai\u0000gpt-6.1-sol');
  assert.ok(gpt);
  assert.equal(gpt.source.id, 'models.dev');
  assert.equal(gpt.source.authority, 40);
  assert.equal(gpt.status, 'priced');
});
