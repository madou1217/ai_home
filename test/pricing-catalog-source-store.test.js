'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createPricingCatalogSourceStore } = require('../lib/usage/pricing/catalog-source-store');
const { createLayeredPricingProvider, mergePricingRecords } = require('../lib/usage/pricing-providers/catalog-layered');

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-pricing-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function quote(value = 2) {
  return {
    provider: 'openai',
    model: 'gpt-test',
    input: value,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: null,
    cacheWrite1h: null,
    reasoning: null,
    source: {
      id: 'official:openai',
      kind: 'official',
      authority: 90,
      confidence: 0.9,
      fetchedAt: '2026-10-20T00:00:00.000Z',
      url: 'https://openai.com/pricing'
    }
  };
}

test('pricing source snapshots are applied once without a review', (t) => {
  const aiHomeDir = tempHome(t);
  const store = createPricingCatalogSourceStore({ aiHomeDir });
  const result = store.applySnapshot({
    sourceId: 'official:openai',
    source: { id: 'official:openai', kind: 'official' },
    quotes: [quote(2)],
    fetchedAt: '2026-10-20T00:00:00.000Z'
  });
  assert.equal(result.applied, true);
  assert.equal(result.reviewRequired, false);
  assert.equal(store.listSources().length, 1);
  assert.equal(store.buildPricingRecords()[0].inputCostPerToken, 2 / 1_000_000);
});

test('changed prices wait in the review queue and never overwrite the active snapshot', (t) => {
  const aiHomeDir = tempHome(t);
  const store = createPricingCatalogSourceStore({ aiHomeDir });
  store.applySnapshot({
    sourceId: 'official:openai',
    source: { id: 'official:openai', kind: 'official' },
    quotes: [quote(2)],
    fetchedAt: '2026-10-20T00:00:00.000Z'
  });
  const changed = store.applySnapshot({
    sourceId: 'official:openai',
    source: { id: 'official:openai', kind: 'official' },
    quotes: [quote(3)],
    fetchedAt: '2026-10-21T00:00:00.000Z'
  });
  assert.equal(changed.applied, false);
  assert.equal(changed.reviewRequired, true);
  assert.equal(changed.reviews.length, 1);
  assert.equal(store.listReviews({ status: 'pending' }).length, 1);
  assert.equal(store.buildPricingRecords()[0].inputCostPerToken, 2 / 1_000_000);

  store.rejectSource('official:openai');
  assert.equal(store.listReviews({ status: 'rejected' }).length, 1);
  assert.equal(store.buildPricingRecords()[0].inputCostPerToken, 2 / 1_000_000);

  const retried = store.applySnapshot({
    sourceId: 'official:openai',
    source: { id: 'official:openai', kind: 'official' },
    quotes: [quote(3)],
    fetchedAt: '2026-10-21T00:00:00.000Z'
  });
  assert.equal(retried.reviewRequired, true);
  store.approveSource('official:openai');
  assert.equal(store.buildPricingRecords()[0].inputCostPerToken, 3 / 1_000_000);
  assert.equal(store.listReviews({ status: 'approved' }).length, 1);
});

test('source ids with colons and underscores never share a snapshot file', (t) => {
  const store = createPricingCatalogSourceStore({ aiHomeDir: tempHome(t) });
  store.applySnapshot({
    sourceId: 'official:a',
    source: { id: 'official:a', kind: 'official' },
    quotes: [{ ...quote(2), model: 'model-a' }]
  });
  store.applySnapshot({
    sourceId: 'official__a',
    source: { id: 'official__a', kind: 'official' },
    quotes: [{ ...quote(3), model: 'model-b' }]
  });
  const sources = store.listSources();
  assert.equal(sources.length, 2);
  assert.equal(store.readSource('official:a').quotes[0].input, 2);
  assert.equal(store.readSource('official__a').quotes[0].input, 3);
});

test('an empty or failed collection leaves the previous snapshot intact', (t) => {
  const aiHomeDir = tempHome(t);
  const store = createPricingCatalogSourceStore({ aiHomeDir });
  store.applySnapshot({
    sourceId: 'official:openai',
    source: { id: 'official:openai', kind: 'official' },
    quotes: [quote(2)],
    fetchedAt: '2026-10-20T00:00:00.000Z'
  });
  // 模拟采集失败：调用方不会调用 applySnapshot；读到的仍是旧快照。
  const before = store.readSource('official:openai');
  assert.equal(before.quotes.length, 1);
  assert.equal(store.buildPricingRecords()[0].inputCostPerToken, 2 / 1_000_000);
});

test('layered pricing records override only non-null dimensions of the base catalog', () => {
  const base = {
    model: 'openai/gpt-test',
    inputCostPerToken: 1 / 1_000_000,
    outputCostPerToken: 9 / 1_000_000,
    cacheReadInputTokenCost: null,
    cacheCreationInputTokenCost: null,
    reasoningOutputTokenCost: null,
    contextCostTiers: []
  };
  const extra = {
    model: 'openai/gpt-test',
    inputCostPerToken: 2 / 1_000_000,
    outputCostPerToken: null,
    cacheReadInputTokenCost: 0.2 / 1_000_000,
    cacheCreationInputTokenCost: null,
    reasoningOutputTokenCost: null,
    contextCostTiers: []
  };
  const merged = mergePricingRecords([base], [extra]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].inputCostPerToken, 2 / 1_000_000);
  assert.equal(merged[0].outputCostPerToken, 9 / 1_000_000);
  assert.equal(merged[0].cacheReadInputTokenCost, 0.2 / 1_000_000);
});

test('layered provider adds external records to its snapshot', (t) => {
  const aiHomeDir = tempHome(t);
  const store = createPricingCatalogSourceStore({ aiHomeDir });
  store.applySnapshot({
    sourceId: 'official:openai',
    source: { id: 'official:openai', kind: 'official' },
    quotes: [quote(2)]
  });
  const base = {
    id: 'models.dev',
    loadSnapshot: () => ({ records: [], fingerprint: '', providerId: 'models.dev' }),
    resolve: () => ({ status: 'unknown' })
  };
  const provider = createLayeredPricingProvider(base, { store });
  const snapshot = provider.loadSnapshot();
  assert.equal(snapshot.externalRecords, 1);
  assert.equal(snapshot.records[0].model, 'openai/gpt-test');
  assert.equal(snapshot.fingerprint.length, 64);
});

test('community parsers normalize per-token feeds into per-million quotes', () => {
  const { parseLiteLlm, parseOpenRouter } = require('../lib/usage/pricing/community-sources');
  const litellm = parseLiteLlm({
    'openai/gpt-test': {
      input_cost_per_token: 0.000002,
      output_cost_per_token: 0.000010,
      cache_read_input_token_cost: 0.0000002
    }
  });
  assert.equal(litellm.length, 1);
  assert.equal(litellm[0].provider, 'openai');
  assert.equal(litellm[0].model, 'gpt-test');
  assert.equal(litellm[0].input, 2);
  assert.equal(litellm[0].output, 10);
  const openrouter = parseOpenRouter({
    data: [{ id: 'anthropic/claude-test', pricing: { prompt: '0.000003', completion: '0.000015' } }]
  });
  assert.equal(openrouter.length, 1);
  assert.equal(openrouter[0].input, 3);
  assert.equal(openrouter[0].output, 15);
});

test('community refresh writes a snapshot through the same review gate', async (t) => {
  const { refreshCommunitySource } = require('../lib/usage/pricing/community-sources');
  const aiHomeDir = tempHome(t);
  const store = createPricingCatalogSourceStore({ aiHomeDir });
  const result = await refreshCommunitySource('community:openrouter', {
    store,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { data: [{ id: 'openai/gpt-test', pricing: { prompt: '0.000002', completion: '0.000010' } }] };
      }
    })
  });
  assert.equal(result.applied, true);
  assert.equal(result.quoteCount, 1);
  assert.equal(store.listSources()[0].sourceId, 'community:openrouter');
});
