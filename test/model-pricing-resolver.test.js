'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PRICING_RESOLUTION_STATUS,
  createModelPricingResolver
} = require('../lib/usage/model-pricing-resolver');
const {
  createModelsDevPricingProvider
} = require('../lib/usage/pricing-providers/models-dev');
const { openModelUsageStore } = require('../lib/usage/model-usage-store');
const { createModelUsageService } = require('../lib/usage/model-usage-service');

function writeCatalogFixture(catalog) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-pricing-resolver-'));
  const catalogPath = path.join(root, 'catalog.json');
  fs.writeFileSync(catalogPath, JSON.stringify(catalog), 'utf8');
  return { root, catalogPath };
}

function model(cost) {
  return {
    id: '',
    modalities: { input: ['text'], output: ['text'] },
    cost
  };
}

test('ModelPricingResolver selects one registered provider instead of hard-coding models.dev', () => {
  const calls = [];
  const resolver = createModelPricingResolver({
    providers: [
      {
        id: 'models.dev',
        resolve() {
          calls.push('models.dev');
          return { status: PRICING_RESOLUTION_STATUS.UNKNOWN };
        }
      },
      {
        id: 'price-table',
        resolve(input) {
          calls.push(`price-table:${input.model}`);
          return {
            status: PRICING_RESOLUTION_STATUS.PRICED,
            matchedModel: 'custom/gpt-next',
            pricing: { model: 'custom/gpt-next', inputCostPerToken: 0.000001 }
          };
        }
      }
    ]
  });

  const resolution = resolver.resolve({
    sourceProviderId: 'price-table',
    provider: 'codex',
    model: 'gpt-next'
  });

  assert.equal(resolution.status, PRICING_RESOLUTION_STATUS.PRICED);
  assert.equal(resolution.sourceProviderId, 'price-table');
  assert.equal(resolution.matchedModel, 'custom/gpt-next');
  assert.deepEqual(calls, ['price-table:gpt-next']);
});

test('models.dev pricing provider resolves dynamic provider identities and preserves explicit zero prices', (t) => {
  const fixture = writeCatalogFixture({
    models: {
      'xai/grok-4.3': {
        id: 'xai/grok-4.3',
        modalities: { input: ['text'], output: ['text'] }
      },
      'zhipuai/glm-5.3': {
        id: 'zhipuai/glm-5.3',
        modalities: { input: ['text'], output: ['text'] }
      }
    },
    providers: {
      xai: {
        id: 'xai',
        models: {
          'grok-4.3': { ...model({ input: 1.25, output: 2.5 }), id: 'grok-4.3' }
        }
      },
      'zai-coding-plan': {
        id: 'zai-coding-plan',
        models: {
          'glm-5.3': { ...model({ input: 0, output: 0 }), id: 'glm-5.3' }
        }
      },
      'kimi-for-coding': {
        id: 'kimi-for-coding',
        models: {
          'k3-256k': { ...model({ input: 0, output: 0, cache_read: 0 }), id: 'k3-256k' }
        }
      },
      google: {
        id: 'google',
        models: {
          'gemini-3.7-flash': {
            ...model({ input: 0.75, output: 3.75, cache_read: 0.075 }),
            id: 'gemini-3.7-flash'
          }
        }
      }
    }
  });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const provider = createModelsDevPricingProvider({
    fs,
    modelsDevCatalogPath: fixture.catalogPath
  });
  const snapshot = provider.loadSnapshot();
  const pricingByModel = Object.fromEntries(
    snapshot.records.map((record) => [record.model, record])
  );
  const resolver = createModelPricingResolver({ providers: [provider] });
  const resolve = (providerId, modelId) => resolver.resolve({
    sourceProviderId: 'models.dev',
    provider: providerId,
    model: modelId
  }, { pricingByModel });

  assert.equal(snapshot.records.length, 4, 'explicit zero prices remain addressable records');
  assert.deepEqual(
    [resolve('grok', 'grok-4.3').status, resolve('grok', 'grok-4.3').matchedModel],
    [PRICING_RESOLUTION_STATUS.PRICED, 'xai/grok-4.3']
  );
  assert.deepEqual(
    [resolve('zcode', 'glm-5.3').status, resolve('zcode', 'glm-5.3').matchedModel],
    [PRICING_RESOLUTION_STATUS.KNOWN_ZERO, 'zai-coding-plan/glm-5.3']
  );
  assert.deepEqual(
    [resolve('kimi', 'kimi-code/k3-256k').status, resolve('kimi', 'kimi-code/k3-256k').matchedModel],
    [PRICING_RESOLUTION_STATUS.KNOWN_ZERO, 'kimi-for-coding/k3-256k']
  );
  assert.equal(
    resolve('agy', 'gemini-3.7-flash').matchedModel,
    'google/gemini-3.7-flash'
  );
  assert.equal(resolve('codex', 'unknown-model').status, PRICING_RESOLUTION_STATUS.UNKNOWN);
});

test('models.dev pricing provider indexes one active pricing snapshot only once', (t) => {
  const fixture = writeCatalogFixture({
    models: {},
    providers: {
      xai: {
        id: 'xai',
        models: {
          'grok-4.3': { ...model({ input: 1, output: 2 }), id: 'grok-4.3' }
        }
      }
    }
  });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const provider = createModelsDevPricingProvider({
    fs,
    modelsDevCatalogPath: fixture.catalogPath
  });
  let enumerations = 0;
  const pricingByModel = new Proxy({
    'xai/grok-4.3': {
      model: 'xai/grok-4.3',
      inputCostPerToken: 0.000001,
      outputCostPerToken: 0.000002
    }
  }, {
    ownKeys(target) {
      enumerations += 1;
      return Reflect.ownKeys(target);
    }
  });
  const resolver = createModelPricingResolver({ providers: [provider] });

  for (let index = 0; index < 32; index += 1) {
    assert.equal(resolver.resolve({
      sourceProviderId: 'models.dev',
      provider: 'grok',
      model: 'grok-4.3'
    }, { pricingByModel }).matchedModel, 'xai/grok-4.3');
  }
  assert.equal(enumerations, 1);
});

test('models.dev pricing provider reloads a replaced catalog in the same long-lived instance', (t) => {
  const fixture = writeCatalogFixture({
    models: {
      'old-lab/retired': {
        id: 'old-lab/retired',
        modalities: { input: ['text'], output: ['text'] }
      }
    },
    providers: {
      'old-lab': {
        id: 'old-lab',
        models: {
          retired: { ...model({ input: 9, output: 9 }), id: 'retired' }
        }
      }
    }
  });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const provider = createModelsDevPricingProvider({
    fs,
    modelsDevCatalogPath: fixture.catalogPath
  });
  const firstSnapshot = provider.loadSnapshot();

  fs.writeFileSync(fixture.catalogPath, JSON.stringify({
    models: {
      'openai/gpt-next': {
        id: 'openai/gpt-next',
        modalities: { input: ['text'], output: ['text'] }
      }
    },
    providers: {
      openai: {
        id: 'openai',
        models: {
          'gpt-next': { ...model({ input: 4, output: 8 }), id: 'gpt-next' }
        }
      }
    }
  }), 'utf8');

  const secondSnapshot = provider.loadSnapshot({ forceReload: true });
  const pricingByModel = Object.fromEntries(
    secondSnapshot.records.map((record) => [record.model, record])
  );
  const resolver = createModelPricingResolver({ providers: [provider] });
  const resolution = resolver.resolve({
    sourceProviderId: 'models.dev',
    provider: 'codex',
    model: 'old-lab/gpt-next'
  }, { pricingByModel });

  assert.notEqual(secondSnapshot.fingerprint, firstSnapshot.fingerprint);
  assert.deepEqual(secondSnapshot.records.map((record) => record.model), ['openai/gpt-next']);
  assert.equal(resolution.matchedModel, 'openai/gpt-next');
});

test('ModelPricingResolver keeps unknown, known-zero, and priced results distinct', () => {
  const resolver = createModelPricingResolver({
    providers: [{
      id: 'fixture',
      resolve(input) {
        if (input.model === 'free') {
          return {
            status: PRICING_RESOLUTION_STATUS.KNOWN_ZERO,
            matchedModel: 'fixture/free',
            pricing: { model: 'fixture/free', inputCostPerToken: 0, outputCostPerToken: 0 }
          };
        }
        return { status: PRICING_RESOLUTION_STATUS.UNKNOWN };
      }
    }]
  });

  const free = resolver.calculateCost({
    sourceProviderId: 'fixture',
    provider: 'fixture',
    model: 'free',
    inputTokens: 1_000_000
  });
  const unknown = resolver.calculateCost({
    sourceProviderId: 'fixture',
    provider: 'fixture',
    model: 'missing',
    inputTokens: 1_000_000
  });

  assert.deepEqual(
    { status: free.status, costUsd: free.costUsd },
    { status: PRICING_RESOLUTION_STATUS.KNOWN_ZERO, costUsd: 0 }
  );
  assert.deepEqual(
    { status: unknown.status, costUsd: unknown.costUsd },
    { status: PRICING_RESOLUTION_STATUS.UNKNOWN, costUsd: null }
  );
});

test('model usage store delegates inserts, recalculation, and account cost visibility to ModelPricingResolver', (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-pricing-store-resolver-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resolver = createModelPricingResolver({
    providers: [{
      id: 'price-table',
      resolve(input, context) {
        if (input.model !== 'gpt-next-alias') {
          return { status: PRICING_RESOLUTION_STATUS.UNKNOWN };
        }
        const pricing = context.pricingByModel['custom/gpt-next'];
        return pricing
          ? {
              status: PRICING_RESOLUTION_STATUS.PRICED,
              matchedModel: pricing.model,
              pricing
            }
          : { status: PRICING_RESOLUTION_STATUS.UNKNOWN };
      }
    }]
  });
  const store = openModelUsageStore({
    fs,
    path,
    aiHomeDir: path.join(root, '.ai_home'),
    DatabaseSync,
    modelPricingResolver: resolver
  });
  t.after(() => store.close());
  const timestampMs = Date.now();
  store.insertUsage({
    eventKey: 'resolver-recalculation',
    provider: 'codex',
    accountRef: 'acct_1234567890abcdef1234',
    model: 'gpt-next-alias',
    inputTokens: 1_000_000,
    costUsd: 99,
    timestampMs
  });
  const fingerprint = 'a'.repeat(64);
  const activation = store.activatePricingCatalog([{
    model: 'custom/gpt-next',
    inputCostPerToken: 0.000002
  }], {
    source: `price-table:v2:${fingerprint}`,
    sourceFamily: 'price-table',
    formatVersion: 'v2',
    fingerprint,
    expectedActiveSource: '',
    expectedActiveEpoch: 0
  });
  const maintenance = store.recalculatePricingMaintenanceBatch({
    expectedSource: activation.activeCatalog.source,
    expectedEpoch: activation.activeCatalog.epoch,
    batchSize: 10
  });
  assert.equal(maintenance.state.recalculated, 1);

  store.insertUsage({
    eventKey: 'resolver-insert',
    provider: 'codex',
    accountRef: 'acct_1234567890abcdef1234',
    model: 'gpt-next-alias',
    inputTokens: 1_000_000,
    timestampMs
  });

  const persisted = store.db.prepare(`
    SELECT event_key, cost_usd
    FROM model_usage_records
    WHERE event_key IN ('resolver-insert', 'resolver-recalculation')
    ORDER BY event_key
  `).all();
  assert.deepEqual(persisted.map((row) => [row.event_key, Number(row.cost_usd)]), [
    ['resolver-insert', 2],
    ['resolver-recalculation', 2]
  ]);
  const accountUsage = store.queryAccountTokenUsage({ dimensions: ['day'], nowMs: timestampMs });
  assert.equal(accountUsage.acct_1234567890abcdef1234.models[0].dayCostUsd, 4);
});

test('model usage service wires models.dev as a resolver provider for paid and known-zero models', async (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return;
  }
  const fixture = writeCatalogFixture({
    models: {
      'xai/grok-4.3': {
        id: 'xai/grok-4.3',
        modalities: { input: ['text'], output: ['text'] }
      }
    },
    providers: {
      xai: {
        id: 'xai',
        models: {
          'grok-4.3': { ...model({ input: 1, output: 2 }), id: 'grok-4.3' }
        }
      },
      'kimi-for-coding': {
        id: 'kimi-for-coding',
        models: {
          'k3-256k': { ...model({ input: 0, output: 0 }), id: 'k3-256k' }
        }
      }
    }
  });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const service = createModelUsageService({
    fs,
    path,
    aiHomeDir: path.join(fixture.root, '.ai_home'),
    hostHomeDir: fixture.root,
    modelsDevCatalogPath: fixture.catalogPath,
    DatabaseSync,
    enableAsyncQueries: false
  });
  const sync = await service.syncPricingIfStale();
  assert.equal(sync.ok, true);
  assert.equal(sync.upserted, 2);
  const timestampMs = Date.now();
  service.recordUsageBatch([
    {
      eventKey: 'resolver-service-paid',
      provider: 'grok',
      accountRef: 'acct_1234567890abcdef1234',
      model: 'grok-4.3',
      inputTokens: 1_000_000,
      timestampMs
    },
    {
      eventKey: 'resolver-service-zero',
      provider: 'kimi',
      accountRef: 'acct_1234567890abcdef1234',
      model: 'kimi-code/k3-256k',
      inputTokens: 1_000_000,
      timestampMs
    }
  ]);

  const rows = service.getCostByModel({ fromMs: timestampMs - 1, toMs: timestampMs + 1 });
  assert.deepEqual(rows.map((row) => [row.model, row.costUsd]), [
    ['grok-4.3', 1],
    ['kimi-code/k3-256k', 0]
  ]);
  const accountUsage = service.getAccountTokenUsage({ dimensions: ['day'], nowMs: timestampMs });
  assert.deepEqual(
    accountUsage.acct_1234567890abcdef1234.models.map((item) => [item.model, item.dayCostUsd]),
    [['grok-4.3', 1], ['kimi-code/k3-256k', 0]]
  );
});

test('model usage service synchronizes a selected pricing provider without knowing its implementation', async (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-selected-pricing-provider-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pricingProvider = {
    id: 'price-table',
    loadSnapshot() {
      return {
        providerId: 'price-table',
        fingerprint: 'b'.repeat(64),
        revision: 'revision-1',
        records: [{
          model: 'private/gpt-next',
          inputCostPerToken: 0.000004
        }]
      };
    },
    resolve(input, context) {
      if (input.model !== 'gpt-next') return { status: PRICING_RESOLUTION_STATUS.UNKNOWN };
      const pricing = context.pricingByModel['private/gpt-next'];
      return pricing
        ? { status: PRICING_RESOLUTION_STATUS.PRICED, matchedModel: pricing.model, pricing }
        : { status: PRICING_RESOLUTION_STATUS.UNKNOWN };
    }
  };
  const service = createModelUsageService({
    fs,
    path,
    aiHomeDir: path.join(root, '.ai_home'),
    hostHomeDir: root,
    DatabaseSync,
    pricingProvider
  });
  t.after(() => service.close());

  const sync = await service.syncPricingIfStale();
  assert.equal(sync.source, 'price-table');
  assert.equal(sync.upserted, 1);
  const timestampMs = Date.now();
  service.recordUsage({
    eventKey: 'selected-provider-price',
    provider: 'codex',
    accountRef: 'acct_1234567890abcdef1234',
    model: 'gpt-next',
    inputTokens: 1_000_000,
    timestampMs
  });
  assert.equal(service.getCostByModel({})[0].costUsd, 4);
  const accountUsage = await service.getAccountTokenUsageAsync({
    dimensions: ['day'],
    nowMs: timestampMs
  });
  assert.equal(
    accountUsage.acct_1234567890abcdef1234.models[0].dayCostUsd,
    4,
    'custom pricing must not be lost through an unserializable query worker boundary'
  );
});
