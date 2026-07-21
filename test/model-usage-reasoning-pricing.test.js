'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  calculateCostUsd,
  normalizePricingRecord
} = require('../lib/usage/model-usage-pricing');
const { openModelUsageStore } = require('../lib/usage/model-usage-store');

function requireDatabaseSync(t) {
  try {
    return require('node:sqlite').DatabaseSync;
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return null;
  }
}

test('reasoning tokens inherit output pricing only when no dedicated price is declared', () => {
  const record = { reasoningOutputTokens: 1_000_000 };

  assert.equal(calculateCostUsd(record, {
    outputCostPerToken: 0.000009
  }), 9);
  assert.equal(calculateCostUsd(record, {
    outputCostPerToken: 0.000009,
    reasoningOutputTokenCost: 0
  }), 0);

  const tieredRecord = {
    inputTokens: 300_000,
    reasoningOutputTokens: 1_000_000
  };
  assert.equal(calculateCostUsd(tieredRecord, {
    inputCostPerToken: 0,
    outputCostPerToken: 0.000009,
    contextCostTiers: [{
      size: 272_000,
      inputCostPerToken: 0,
      outputCostPerToken: 0.000012
    }]
  }), 12);
  assert.equal(calculateCostUsd(tieredRecord, {
    inputCostPerToken: 0,
    outputCostPerToken: 0.000009,
    contextCostTiers: [{
      size: 272_000,
      inputCostPerToken: 0,
      outputCostPerToken: 0.000012,
      reasoningOutputTokenCost: 0
    }]
  }), 0);
});

test('pricing persistence distinguishes a missing reasoning price from an explicit zero', (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-reasoning-pricing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = openModelUsageStore({
    fs,
    path,
    aiHomeDir: path.join(root, '.ai_home'),
    DatabaseSync
  });
  assert.ok(store);

  try {
    store.upsertPricing([
      normalizePricingRecord('openai/inherit-output', {
        outputCostPerToken: 0.000009
      }),
      normalizePricingRecord('openai/free-reasoning', {
        outputCostPerToken: 0.000009,
        reasoningOutputTokenCost: 0
      })
    ], { source: 'test' });

    const pricing = store.getAllPricing();
    assert.equal(pricing['openai/inherit-output'].reasoningOutputTokenCost, null);
    assert.equal(pricing['openai/free-reasoning'].reasoningOutputTokenCost, 0);
  } finally {
    store.close();
  }
});
