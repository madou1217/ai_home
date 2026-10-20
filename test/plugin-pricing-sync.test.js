'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createPluginPricingSync } = require('../lib/plugins/pricing/catalog-sync');
const { createPricingCatalogSourceStore } = require('../lib/usage/pricing/catalog-source-store');

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-plugin-pricing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runtimeWith(handler) {
  const contribution = { id: 'official.catalog', instanceId: 'pricing-1', capability: 'pricing.catalog', handler };
  const snapshot = { byCapability: new Map([['pricing.catalog', [contribution]]]) };
  return {
    acquire: () => ({ generation: 1, snapshot, release() {} }),
    async invoke() { return { value: await handler() }; },
    onChange: () => () => {}
  };
}

function quote(value) {
  return {
    provider: 'openai',
    model: 'gpt-test',
    input: value,
    output: 10,
    source: {
      id: 'official:openai',
      kind: 'official',
      authority: 90,
      confidence: 0.9,
      fetchedAt: '2026-10-20T00:00:00.000Z'
    }
  };
}

test('pricing sync applies the first snapshot and queues later changes for review', async (t) => {
  const aiHomeDir = tempHome(t);
  const store = createPricingCatalogSourceStore({ aiHomeDir });
  let current = 2;
  const sync = createPluginPricingSync({
    runtime: runtimeWith(() => ({ generatedAt: '2026-10-20T00:00:00.000Z', quotes: [quote(current)] })),
    store
  });
  const first = await sync.syncNow();
  assert.equal(first.ok, true);
  assert.equal(first.sources[0].applied, true);
  assert.equal(store.buildPricingRecords()[0].inputCostPerToken, 2 / 1_000_000);

  current = 3;
  const second = await sync.syncNow();
  assert.equal(second.ok, true);
  assert.equal(second.reviews.length, 1);
  assert.equal(store.listReviews({ status: 'pending' }).length, 1);
  // 变化尚未复核，计费仍使用旧快照。
  assert.equal(store.buildPricingRecords()[0].inputCostPerToken, 2 / 1_000_000);
});

test('pricing sync keeps the old snapshot when a plugin fails', async (t) => {
  const aiHomeDir = tempHome(t);
  const store = createPricingCatalogSourceStore({ aiHomeDir });
  let fail = false;
  const sync = createPluginPricingSync({
    runtime: runtimeWith(() => {
      if (fail) throw Object.assign(new Error('upstream down'), { code: 'pricing_feed_down' });
      return { quotes: [quote(2)] };
    }),
    store
  });
  await sync.syncNow();
  fail = true;
  const report = await sync.syncNow();
  assert.equal(report.ok, false);
  assert.equal(report.attempts[0].error, 'pricing_feed_down');
  assert.equal(store.buildPricingRecords()[0].inputCostPerToken, 2 / 1_000_000);
});

test('community pricing refreshes without an active plugin runtime', async (t) => {
  const store = createPricingCatalogSourceStore({ aiHomeDir: tempHome(t) });
  let calls = 0;
  let appliedCalls = 0;
  const sync = createPluginPricingSync({
    runtime: null,
    store,
    communityRefresh: ({ store: target }) => {
      calls += 1;
      const outcome = target.applySnapshot({
        sourceId: 'community:litellm',
        source: { id: 'community:litellm', kind: 'community' },
        quotes: [quote(4)],
        requireReview: true
      });
      return [{
        sourceId: 'community:litellm',
        ok: true,
        quoteCount: 1,
        applied: outcome.applied === true
      }];
    },
    onApplied: () => { appliedCalls += 1; }
  });
  const report = await sync.syncNow({ community: true });
  assert.equal(report.ok, true);
  assert.equal(report.runtimeActive, false);
  assert.equal(calls, 1);
  assert.equal(appliedCalls, 1);
  assert.equal(report.community[0].sourceId, 'community:litellm');
  assert.equal(store.buildPricingRecords().length, 1);
});

test('an explicit community refresh is not swallowed by an in-flight plugin collection', async (t) => {
  const store = createPricingCatalogSourceStore({ aiHomeDir: tempHome(t) });
  let releasePlugin;
  const pluginGate = new Promise((resolve) => { releasePlugin = resolve; });
  let communityCalls = 0;
  const sync = createPluginPricingSync({
    runtime: runtimeWith(async () => {
      await pluginGate;
      return { quotes: [quote(2)] };
    }),
    store,
    communityRefresh: () => {
      communityCalls += 1;
      return [];
    }
  });
  const first = sync.syncNow();
  const explicit = sync.syncNow({ community: true });
  releasePlugin();
  await first;
  const report = await explicit;
  assert.equal(communityCalls, 1);
  assert.equal(report.runtimeActive, true);
});
