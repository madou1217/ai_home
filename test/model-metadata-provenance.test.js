'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MODEL_METADATA_SOURCE_ID,
  attachModelMetadata,
  createModelsDevMetadataContribution,
  readModelMetadataSourceStatus
} = require('../lib/server/models-dev-metadata');
const { PRICE_SOURCE_AUTHORITY } = require('../lib/usage/pricing/price-quote');

const GENERATED_AT = '2026-10-19T05:32:55.764Z';
const NOW = Date.parse('2026-10-20T00:00:00.000Z');

function catalogFixture() {
  return {
    models: {
      'openai/gpt-5': {
        id: 'openai/gpt-5',
        name: 'GPT-5',
        limit: { context: 400000, output: 128000 },
        modalities: { input: ['text', 'image'], output: ['text'] }
      }
    },
    providers: {
      openai: {
        id: 'openai',
        models: {
          'gpt-5': {
            id: 'gpt-5',
            name: 'GPT-5',
            limit: { context: 400000, output: 128000 },
            modalities: { input: ['text', 'image'], output: ['text'] },
            cost: { input: 1.25, output: 10 }
          }
        }
      }
    }
  };
}

function deps(overrides = {}) {
  return {
    modelsDevCatalog: catalogFixture(),
    generatedAt: GENERATED_AT,
    now: () => NOW,
    ...overrides
  };
}

test('model.metadata attaches source, authority, fetchedAt and freshness for resolved models', () => {
  const [item] = attachModelMetadata([{ id: 'gpt-5', provider: 'codex' }], deps());
  assert.equal(item.metadata.metadataStatus, 'resolved');
  assert.equal(item.metadata.metadataSource, MODEL_METADATA_SOURCE_ID);
  assert.equal(item.metadata.metadataAuthority, PRICE_SOURCE_AUTHORITY.aggregator);
  assert.equal(item.metadata.metadataFetchedAt, GENERATED_AT);
  assert.equal(item.metadata.metadataStale, false);
  assert.equal(item.metadata.source.id, MODEL_METADATA_SOURCE_ID);
  assert.equal(item.metadata.source.kind, 'aggregator');
  assert.equal(item.metadata.source.fetchedAt, GENERATED_AT);
  assert.equal(item.metadata.pricing.status, 'priced');
});

test('model.metadata keeps unknown explicit instead of inventing capabilities or zero cost', () => {
  const [item] = attachModelMetadata([{ id: 'not-in-catalog', provider: 'codex' }], deps());
  assert.equal(item.metadata.metadataStatus, 'unknown');
  assert.equal(item.metadata.pricing.status, 'unknown');
  assert.equal(item.metadata.limits, undefined);
  assert.equal(item.metadata.cost, undefined);
});

test('model.metadata marks a stale catalog without dropping the data', () => {
  const contribution = createModelsDevMetadataContribution(deps({
    generatedAt: '2026-09-01T00:00:00.000Z'
  }));
  const metadata = contribution.resolve({ id: 'gpt-5', provider: 'codex' });
  assert.equal(metadata.metadataStatus, 'resolved');
  assert.equal(metadata.metadataStale, true);
  assert.equal(metadata.source.stale, true);
  assert.equal(metadata.cost.input, 1.25);
});

test('model metadata source status is available for diagnostics', () => {
  const lines = readModelMetadataSourceStatus(deps());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /model metadata: models\.dev/);
  assert.match(lines[0], /authority=40/);
  assert.match(lines[0], /fetched_at=2026-10-19T05:32:55\.764Z/);
});
