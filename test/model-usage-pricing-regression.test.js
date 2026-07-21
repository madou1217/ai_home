const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PRICING_CATALOG_FORMAT_VERSION,
  matchModelPricing
} = require('../lib/usage/model-usage-pricing');
const { openModelUsageStore } = require('../lib/usage/model-usage-store');
const { stableHash } = require('../lib/usage/model-usage-stable-hash');
const {
  buildModelsDevPricingRecords,
  DEFAULT_MODELS_DEV_DIR
} = require('../lib/server/models-dev-metadata');

function createModelUsageService(options) {
  return require('../lib/usage/model-usage-service').createModelUsageService(options);
}

function requireDatabaseSync(t) {
  try {
    return require('node:sqlite').DatabaseSync;
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return null;
  }
}

function writeModelPrice(root, input, output) {
  writeOpenAiModelPrice(root, 'gpt-standard', input, output);
}

function writeOpenAiModelPrice(root, model, input, output) {
  const filePath = path.join(root, 'providers', 'openai', 'models', `${model}.toml`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `[cost]\ninput = ${input}\noutput = ${output}\n`, 'utf8');
}

function writeGeminiFlashPrice(root) {
  const filePath = path.join(root, 'providers', 'google', 'models', 'gemini-3.5-flash.toml');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '[cost]\ninput = 1.5\noutput = 9\n', 'utf8');
}

function activateTestCatalog(store, fingerprint, inputCostPerToken, sourceFamily = 'test') {
  const current = store.getActivePricingCatalog();
  return store.activatePricingCatalog([{
    model: 'openai/gpt-standard',
    inputCostPerToken
  }], {
    source: `${sourceFamily}:v2:${fingerprint}`,
    sourceFamily,
    formatVersion: PRICING_CATALOG_FORMAT_VERSION,
    fingerprint,
    expectedActiveSource: String(current && current.source || '').trim(),
    expectedActiveEpoch: Number(current && current.epoch) || 0
  });
}

function createImmediateHookDatabaseSync(DatabaseSync, hook) {
  return class HookedDatabaseSync extends DatabaseSync {
    exec(sql) {
      if (/^\s*BEGIN IMMEDIATE\b/i.test(String(sql)) && hook.beforeImmediate) {
        const beforeImmediate = hook.beforeImmediate;
        hook.beforeImmediate = null;
        beforeImmediate();
      }
      return super.exec(sql);
    }
  };
}

function createPricingInterleavingFixture(t, DatabaseSync) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-pricing-write-cas-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const hook = { beforeImmediate: null };
  const HookedDatabaseSync = createImmediateHookDatabaseSync(DatabaseSync, hook);

  const seed = openModelUsageStore({ fs, path, aiHomeDir, DatabaseSync });
  activateTestCatalog(seed, 'a'.repeat(64), 0.000001);
  seed.close();
  const store = openModelUsageStore({
    fs,
    path,
    aiHomeDir,
    DatabaseSync: HookedDatabaseSync
  });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    store,
    activateCatalogBOnNextWrite() {
      hook.beforeImmediate = () => {
        const switcher = openModelUsageStore({ fs, path, aiHomeDir, DatabaseSync });
        try {
          activateTestCatalog(switcher, 'b'.repeat(64), 0.000003);
        } finally {
          switcher.close();
        }
      };
    }
  };
}

test('model usage pricing resolves attributed and wire model identities exactly', () => {
  const pricing = {
    'google/gemini-3.5-flash': {
      model: 'google/gemini-3.5-flash',
      inputCostPerToken: 0.0000015,
      outputCostPerToken: 0.000009
    },
    'openai/gpt-5.6-sol': {
      model: 'openai/gpt-5.6-sol',
      inputCostPerToken: 0.000005,
      outputCostPerToken: 0.00003
    },
    '302ai/claude-opus-4-6-thinking': {
      model: '302ai/claude-opus-4-6-thinking',
      inputCostPerToken: 999
    },
    'anthropic/claude-opus-4-6': {
      model: 'anthropic/claude-opus-4-6',
      inputCostPerToken: 0.000005
    }
  };

  [
    'agy.gemini-3-flash-agent',
    'agy.gemini-3-flash-a',
    'agy.gemini-default'
  ].forEach((model) => {
    assert.equal(matchModelPricing(model, pricing, 'claude').model, 'google/gemini-3.5-flash');
  });
  assert.equal(
    matchModelPricing('codex.gpt-5.6-sol', pricing, 'claude').model,
    'openai/gpt-5.6-sol'
  );
  assert.equal(
    matchModelPricing('agy.claude-opus-4-6-thinking', pricing, 'claude').model,
    'anthropic/claude-opus-4-6'
  );
  assert.equal(matchModelPricing('claude-opus-4-6-thinking-extra', pricing, 'agy'), null);
});

test('model usage pricing builds one normalized index for repeated large-catalog matches', () => {
  const rawPricing = Object.fromEntries(
    Array.from({ length: 4_600 }, (_unused, index) => {
      const model = `openai/hot-model-${index}`;
      return [model, {
        model,
        inputCostPerToken: 0.000001,
        outputCostPerToken: 0.000002
      }];
    })
  );
  let catalogEnumerations = 0;
  const pricing = new Proxy(rawPricing, {
    ownKeys(target) {
      catalogEnumerations += 1;
      return Reflect.ownKeys(target);
    }
  });

  for (let index = 0; index < 128; index += 1) {
    assert.equal(
      matchModelPricing(`hot-model-${index}`, pricing, 'codex').model,
      `openai/hot-model-${index}`
    );
  }

  assert.equal(catalogEnumerations, 1, 'pricing snapshot should be indexed once, not once per record');
});

test('bundled pricing defers historical cost recalculation until explicit maintenance', async (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-pricing-maintenance-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const modelsDevDir = path.join(root, 'models.dev');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  writeModelPrice(modelsDevDir, 1, 2);

  const createService = () => createModelUsageService({
    fs,
    path,
    aiHomeDir,
    hostHomeDir: root,
    modelsDevDir,
    DatabaseSync
  });

  try {
    const firstService = createService();
    firstService.recordUsage({
      eventKey: 'pricing-maintenance-sentinel',
      provider: 'codex',
      model: 'gpt-standard',
      inputTokens: 1_000_000,
      costUsd: 123,
      timestampMs: new Date(2026, 6, 16, 12).getTime()
    });

    const automaticSync = await firstService.syncPricingIfStale();
    assert.equal(automaticSync.synced, true);
    assert.equal(automaticSync.recalculated, 0);
    assert.equal(automaticSync.recalculationRequired, true);

    const restartedService = createService();
    const stillPending = await restartedService.syncPricingIfStale();
    assert.equal(stillPending.synced, false);
    assert.equal(stillPending.recalculationRequired, true);

    const maintenance = await restartedService.syncPricingIfStale({
      recalculateCosts: true
    });
    assert.equal(maintenance.synced, false);
    assert.equal(maintenance.recalculated, 1);
    assert.equal(maintenance.recalculationRequired, false);

    const finalService = createService();
    const completed = await finalService.syncPricingIfStale();
    assert.equal(completed.recalculationRequired, false);
    const query = {
      fromMs: new Date(2026, 6, 16).getTime(),
      toMs: new Date(2026, 6, 17).getTime() - 1
    };
    assert.equal(finalService.getStats(query).totalCostUsd, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bundled pricing maintenance resumes from its persisted batch cursor', async (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-pricing-resume-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const modelsDevDir = path.join(root, 'models.dev');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  writeModelPrice(modelsDevDir, 1, 2);

  const createService = (options = {}) => createModelUsageService({
    fs,
    path,
    aiHomeDir,
    hostHomeDir: root,
    modelsDevDir,
    DatabaseSync,
    ...options
  });

  try {
    const seed = createService();
    for (let index = 0; index < 5; index += 1) {
      seed.recordUsage({
        eventKey: `pricing-resume-${index}`,
        provider: 'codex',
        model: 'gpt-standard',
        inputTokens: 1_000_000,
        costUsd: 123,
        timestampMs: new Date(2026, 6, 16, 12, index).getTime()
      });
    }
    const pending = await seed.syncPricingIfStale();
    assert.equal(pending.recalculationRequired, true);

    let yields = 0;
    const interrupted = createService({
      yieldToEventLoop: async () => {
        yields += 1;
        if (yields === 1) throw new Error('simulated_maintenance_interrupt');
      }
    });
    const failed = await interrupted.syncPricingIfStale({
      recalculateCosts: true,
      batchSize: 2
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, 'simulated_maintenance_interrupt');

    const persisted = new DatabaseSync(path.join(aiHomeDir, 'app-state.db'));
    let interruptedState;
    try {
      const row = persisted.prepare(`
        SELECT value
        FROM app_kv
        WHERE key = 'maintenance:model_usage_pricing'
      `).get();
      interruptedState = JSON.parse(row.value);
    } finally {
      persisted.close();
    }
    assert.equal(interruptedState.status, 'pending');
    assert.equal(interruptedState.cursorId > 0, true);
    assert.equal(interruptedState.cursorId < interruptedState.targetMaxId, true);

    const resumed = await createService().syncPricingIfStale({
      recalculateCosts: true,
      batchSize: 2
    });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.recalculationRequired, false);
    assert.equal(resumed.recalculated, 5);
    assert.equal(resumed.maintenance.status, 'completed');
    assert.equal(resumed.batches >= 3, true);

    const completed = new DatabaseSync(path.join(aiHomeDir, 'app-state.db'));
    try {
      const stateRow = completed.prepare(`
        SELECT value
        FROM app_kv
        WHERE key = 'maintenance:model_usage_pricing'
      `).get();
      const state = JSON.parse(stateRow.value);
      assert.equal(state.status, 'completed');
      assert.equal(state.cursorId, state.targetMaxId);
      const costs = completed.prepare(`
        SELECT cost_usd
        FROM model_usage_records
        ORDER BY id
      `).all();
      assert.deepEqual(costs.map((row) => Number(row.cost_usd)), [1, 1, 1, 1, 1]);
    } finally {
      completed.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reading the same pending bundled catalog does not rewrite its maintenance checkpoint', async (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-pricing-pending-read-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const modelsDevDir = path.join(root, 'models.dev');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  writeModelPrice(modelsDevDir, 1, 2);
  const service = createModelUsageService({
    fs,
    path,
    aiHomeDir,
    hostHomeDir: root,
    modelsDevDir,
    DatabaseSync
  });

  try {
    const first = await service.syncPricingIfStale();
    assert.equal(first.recalculationRequired, true);

    const db = new DatabaseSync(path.join(aiHomeDir, 'app-state.db'));
    try {
      db.prepare(`
        UPDATE app_kv
        SET updated_at = 17
        WHERE key = 'maintenance:model_usage_pricing'
      `).run();
    } finally {
      db.close();
    }

    const second = await service.syncPricingIfStale();
    assert.equal(second.synced, false);
    assert.equal(second.recalculationRequired, true);

    const persisted = new DatabaseSync(path.join(aiHomeDir, 'app-state.db'));
    try {
      const row = persisted.prepare(`
        SELECT updated_at
        FROM app_kv
        WHERE key = 'maintenance:model_usage_pricing'
      `).get();
      assert.equal(row.updated_at, 17);
    } finally {
      persisted.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a stale bundled service cannot replace a newer active catalog', async (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-pricing-catalog-cas-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const modelsDevDir = path.join(root, 'models.dev');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  writeModelPrice(modelsDevDir, 1, 2);
  writeOpenAiModelPrice(modelsDevDir, 'gpt-removed', 7, 8);

  const createService = () => createModelUsageService({
    fs,
    path,
    aiHomeDir,
    hostHomeDir: root,
    modelsDevDir,
    DatabaseSync
  });

  try {
    const staleService = createService();
    const catalogA = await staleService.syncPricingIfStale();
    assert.equal(catalogA.synced, true);

    writeModelPrice(modelsDevDir, 3, 4);
    fs.rmSync(path.join(
      modelsDevDir,
      'providers',
      'openai',
      'models',
      'gpt-removed.toml'
    ));
    const currentService = createService();
    const catalogB = await currentService.syncPricingIfStale({ force: true });
    assert.equal(catalogB.synced, true);
    assert.notEqual(catalogB.catalogFingerprint, catalogA.catalogFingerprint);

    const staleRead = await staleService.syncPricingIfStale();
    assert.equal(staleRead.synced, false);
    assert.equal(staleRead.reason, 'fresh');
    assert.equal(staleRead.catalogFingerprint, catalogB.catalogFingerprint);

    const db = new DatabaseSync(path.join(aiHomeDir, 'app-state.db'));
    try {
      const activeRow = db.prepare(`
        SELECT value
        FROM app_kv
        WHERE key = 'active:model_usage_pricing'
      `).get();
      const maintenanceRow = db.prepare(`
        SELECT value
        FROM app_kv
        WHERE key = 'maintenance:model_usage_pricing'
      `).get();
      const active = JSON.parse(activeRow.value);
      const maintenance = JSON.parse(maintenanceRow.value);
      assert.equal(active.fingerprint, catalogB.catalogFingerprint);
      assert.equal(active.formatVersion, PRICING_CATALOG_FORMAT_VERSION);
      assert.equal(active.updatedAt > 0, true);
      assert.equal(maintenance.source, active.source);
      assert.equal(maintenance.catalogEpoch, active.epoch);
      assert.deepEqual(
        db.prepare('SELECT model, source FROM model_usage_pricing ORDER BY model').all()
          .map((row) => ({ ...row })),
        [{
          model: 'openai/gpt-standard',
          source: active.source
        }]
      );
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pricing maintenance stops when a newer catalog epoch becomes active', async (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-pricing-maintenance-cas-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const modelsDevDir = path.join(root, 'models.dev');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  writeModelPrice(modelsDevDir, 1, 2);

  const createService = (options = {}) => createModelUsageService({
    fs,
    path,
    aiHomeDir,
    hostHomeDir: root,
    modelsDevDir,
    DatabaseSync,
    ...options
  });

  try {
    const staleService = createService();
    for (let index = 0; index < 3; index += 1) {
      staleService.recordUsage({
        eventKey: `pricing-maintenance-cas-${index}`,
        provider: 'codex',
        model: 'gpt-standard',
        inputTokens: 1_000_000,
        costUsd: 99,
        timestampMs: new Date(2026, 6, 16, 12, index).getTime()
      });
    }
    const catalogA = await staleService.syncPricingIfStale();
    assert.equal(catalogA.recalculationRequired, true);

    let catalogB = null;
    let switched = false;
    const staleMaintenance = await staleService.syncPricingIfStale({
      recalculateCosts: true,
      batchSize: 1,
      async onProgress() {
        if (switched) return;
        switched = true;
        writeModelPrice(modelsDevDir, 3, 4);
        catalogB = await createService().syncPricingIfStale({
          recalculateCosts: true,
          batchSize: 1
        });
      }
    });

    assert.equal(catalogB.ok, true);
    assert.equal(catalogB.maintenance.status, 'completed');
    assert.equal(staleMaintenance.ok, false);
    assert.equal(staleMaintenance.reason, 'pricing_catalog_stale_epoch');

    const db = new DatabaseSync(path.join(aiHomeDir, 'app-state.db'));
    try {
      const active = JSON.parse(db.prepare(`
        SELECT value
        FROM app_kv
        WHERE key = 'active:model_usage_pricing'
      `).get().value);
      const maintenance = JSON.parse(db.prepare(`
        SELECT value
        FROM app_kv
        WHERE key = 'maintenance:model_usage_pricing'
      `).get().value);
      assert.equal(active.fingerprint, catalogB.catalogFingerprint);
      assert.equal(maintenance.source, active.source);
      assert.equal(maintenance.catalogEpoch, active.epoch);
      assert.equal(maintenance.status, 'completed');
      assert.deepEqual(
        db.prepare('SELECT cost_usd FROM model_usage_records ORDER BY id').all()
          .map((row) => Number(row.cost_usd)),
        [3, 3, 3]
      );
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy remote pricing is refreshed before explicit maintenance', async (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-pricing-remote-upgrade-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const pricingUrl = 'https://example.test/legacy-pricing.json';
  fs.mkdirSync(aiHomeDir, { recursive: true });

  const createRemoteService = (fetchImpl) => createModelUsageService({
    fs,
    path,
    aiHomeDir,
    hostHomeDir: root,
    pricingUrl,
    fetchImpl,
    DatabaseSync
  });

  try {
    const seed = createRemoteService(async () => ({
      ok: true,
      async json() {
        return {
          'gpt-remote': {
            input_cost_per_token: 0.000001
          }
        };
      }
    }));
    const seededCatalog = await seed.syncPricingIfStale({ force: true });
    assert.equal(seededCatalog.ok, true);
    seed.recordUsage({
      eventKey: 'legacy-remote-pricing-event',
      provider: 'codex',
      model: 'gpt-remote',
      inputTokens: 1_000_000,
      reasoningOutputTokens: 10,
      costUsd: 99,
      timestampMs: new Date(2026, 6, 16, 12).getTime()
    });

    const legacyDb = new DatabaseSync(path.join(aiHomeDir, 'app-state.db'));
    try {
      legacyDb.prepare("DELETE FROM app_kv WHERE key = 'active:model_usage_pricing'").run();
      legacyDb.prepare(`
        UPDATE model_usage_pricing
        SET source = ?, reasoning_output_token_cost = 0
      `).run(`url:${pricingUrl}`);
    } finally {
      legacyDb.close();
    }

    let refreshCalls = 0;
    const upgraded = await createRemoteService(async () => {
      refreshCalls += 1;
      return {
        ok: true,
        async json() {
          return {
            'gpt-remote': {
              input_cost_per_token: 0.000003,
              reasoning_output_token_cost: 0.000007
            }
          };
        }
      };
    }).syncPricingIfStale({ recalculateCosts: true });

    assert.equal(refreshCalls, 1);
    assert.equal(upgraded.ok, true);
    assert.equal(upgraded.recalculationRequired, false);
    assert.match(upgraded.catalogFingerprint, /^[a-f0-9]{64}$/);

    const db = new DatabaseSync(path.join(aiHomeDir, 'app-state.db'));
    try {
      const active = JSON.parse(db.prepare(`
        SELECT value
        FROM app_kv
        WHERE key = 'active:model_usage_pricing'
      `).get().value);
      const usage = db.prepare(`
        SELECT cost_usd
        FROM model_usage_records
        WHERE event_key = 'legacy-remote-pricing-event'
      `).get();
      assert.equal(active.formatVersion, PRICING_CATALOG_FORMAT_VERSION);
      assert.equal(active.fingerprint, upgraded.catalogFingerprint);
      assert.equal(active.updatedAt > 0, true);
      assert.ok(Math.abs(Number(usage.cost_usd) - 3.00007) < 1e-12);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('real-time usage prices inside the same write transaction as insertion', (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const fixture = createPricingInterleavingFixture(t, DatabaseSync);
  fixture.activateCatalogBOnNextWrite();

  const inserted = fixture.store.insertUsageBatch([{
    eventKey: 'pricing-write-cas-realtime',
    provider: 'codex',
    model: 'gpt-standard',
    inputTokens: 1_000_000,
    timestampMs: new Date(2026, 6, 16, 12).getTime()
  }]);

  assert.equal(inserted, 1);
  const usage = fixture.store.db.prepare(`
    SELECT cost_usd
    FROM model_usage_records
    WHERE event_key = 'pricing-write-cas-realtime'
  `).get();
  const maintenance = fixture.store.getPricingMaintenanceState();
  assert.equal(Number(usage.cost_usd), 3);
  assert.equal(maintenance.catalogFingerprint, 'b'.repeat(64));
  assert.equal(maintenance.targetMaxId, 0);
});

test('file projection rebuild prices inside the same write transaction as replacement', (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const fixture = createPricingInterleavingFixture(t, DatabaseSync);
  fixture.activateCatalogBOnNextWrite();

  const filePath = '/tmp/pricing-write-cas.jsonl';
  const sourceHash = stableHash(filePath);
  const result = fixture.store.replaceFileProjection({
    provider: 'codex',
    sourceHash,
    filePath,
    usageRecords: [{
      eventKey: `codex:file:${sourceHash}:0:usage`,
      provider: 'codex',
      model: 'gpt-standard',
      inputTokens: 1_000_000,
      timestampMs: new Date(2026, 6, 16, 12).getTime()
    }],
    promptEvents: [],
    sessionRecords: [],
    fileState: { size: 1, offset: 1 }
  });

  assert.equal(result.records, 1);
  const usage = fixture.store.db.prepare(`
    SELECT cost_usd
    FROM model_usage_records
    WHERE event_key = ?
  `).get(`codex:file:${sourceHash}:0:usage`);
  const maintenance = fixture.store.getPricingMaintenanceState();
  assert.equal(Number(usage.cost_usd), 3);
  assert.equal(maintenance.catalogFingerprint, 'b'.repeat(64));
  assert.equal(maintenance.targetMaxId, 0);
});

test('ordinary pricing reads never downgrade an unknown future active catalog', async (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-pricing-future-format-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const modelsDevDir = path.join(root, 'models.dev');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  writeModelPrice(modelsDevDir, 1, 2);
  const createService = () => createModelUsageService({
    fs,
    path,
    aiHomeDir,
    hostHomeDir: root,
    modelsDevDir,
    DatabaseSync
  });

  try {
    await createService().syncPricingIfStale();
    const db = new DatabaseSync(path.join(aiHomeDir, 'app-state.db'));
    const futureActive = {
      version: 1,
      source: 'models.dev:v3:future',
      sourceFamily: 'models.dev',
      formatVersion: 'v3',
      fingerprint: 'future',
      epoch: 99,
      updatedAt: Date.now()
    };
    const futureMaintenance = {
      version: 1,
      status: 'pending',
      source: futureActive.source,
      pricingSource: futureActive.sourceFamily,
      catalogFingerprint: futureActive.fingerprint,
      catalogEpoch: futureActive.epoch,
      cursorId: 0,
      targetMaxId: 0
    };
    try {
      db.prepare(`
        UPDATE app_kv
        SET value = ?, updated_at = 31
        WHERE key = 'active:model_usage_pricing'
      `).run(JSON.stringify(futureActive));
      db.prepare(`
        UPDATE app_kv
        SET value = ?, updated_at = 32
        WHERE key = 'maintenance:model_usage_pricing'
      `).run(JSON.stringify(futureMaintenance));
    } finally {
      db.close();
    }

    const ordinary = await createService().syncPricingIfStale();
    assert.equal(ordinary.ok, false);
    assert.equal(ordinary.reason, 'pricing_catalog_incompatible');

    const persisted = new DatabaseSync(path.join(aiHomeDir, 'app-state.db'));
    try {
      const activeRow = persisted.prepare(`
        SELECT value, updated_at
        FROM app_kv
        WHERE key = 'active:model_usage_pricing'
      `).get();
      const maintenanceRow = persisted.prepare(`
        SELECT value, updated_at
        FROM app_kv
        WHERE key = 'maintenance:model_usage_pricing'
      `).get();
      assert.deepEqual(JSON.parse(activeRow.value), futureActive);
      assert.equal(activeRow.updated_at, 31);
      assert.deepEqual(JSON.parse(maintenanceRow.value), futureMaintenance);
      assert.equal(maintenanceRow.updated_at, 32);
    } finally {
      persisted.close();
    }

    const explicit = await createService().syncPricingIfStale({ force: true });
    assert.equal(explicit.ok, true);
    assert.equal(explicit.synced, true);
    assert.equal(explicit.maintenance.catalogEpoch, 100);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('explicit catalog activation surfaces a concurrent stale epoch', async (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-pricing-activation-cas-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const modelsDevDir = path.join(root, 'models.dev');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  writeModelPrice(modelsDevDir, 2, 4);

  const seed = openModelUsageStore({ fs, path, aiHomeDir, DatabaseSync });
  activateTestCatalog(seed, '1'.repeat(64), 0.000001, 'models.dev');
  seed.close();
  const hook = { beforeImmediate: null };
  const HookedDatabaseSync = createImmediateHookDatabaseSync(DatabaseSync, hook);
  hook.beforeImmediate = () => {
    const switcher = openModelUsageStore({ fs, path, aiHomeDir, DatabaseSync });
    try {
      activateTestCatalog(switcher, '3'.repeat(64), 0.000003, 'models.dev');
    } finally {
      switcher.close();
    }
  };

  try {
    const result = await createModelUsageService({
      fs,
      path,
      aiHomeDir,
      hostHomeDir: root,
      modelsDevDir,
      DatabaseSync: HookedDatabaseSync
    }).syncPricingIfStale({ force: true });
    assert.equal(result.ok, false);
    assert.equal(result.synced, false);
    assert.equal(result.reason, 'pricing_catalog_stale_epoch');

    const persisted = openModelUsageStore({ fs, path, aiHomeDir, DatabaseSync });
    try {
      assert.equal(persisted.getActivePricingCatalog().fingerprint, '3'.repeat(64));
      assert.equal(persisted.getPricingMaintenanceState().catalogFingerprint, '3'.repeat(64));
    } finally {
      persisted.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('catalog activation rolls back pricing rows when active state persistence fails', (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-pricing-activation-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = openModelUsageStore({
    fs,
    path,
    aiHomeDir: path.join(root, '.ai_home'),
    DatabaseSync
  });
  t.after(() => store.close());
  const catalogA = store.activatePricingCatalog([
    { model: 'openai/gpt-standard', inputCostPerToken: 0.000001 },
    { model: 'openai/gpt-removed', inputCostPerToken: 0.000007 }
  ], {
    source: `test:v2:${'a'.repeat(64)}`,
    sourceFamily: 'test',
    formatVersion: PRICING_CATALOG_FORMAT_VERSION,
    fingerprint: 'a'.repeat(64),
    expectedActiveSource: '',
    expectedActiveEpoch: 0
  });
  store.db.exec(`
    CREATE TRIGGER fail_active_catalog_write
    BEFORE UPDATE ON app_kv
    WHEN NEW.key = 'active:model_usage_pricing'
    BEGIN
      SELECT RAISE(ABORT, 'simulated_active_catalog_write_failure');
    END
  `);

  assert.throws(() => store.activatePricingCatalog([
    { model: 'openai/gpt-standard', inputCostPerToken: 0.000003 }
  ], {
    source: `test:v2:${'b'.repeat(64)}`,
    sourceFamily: 'test',
    formatVersion: PRICING_CATALOG_FORMAT_VERSION,
    fingerprint: 'b'.repeat(64),
    expectedActiveSource: catalogA.activeCatalog.source,
    expectedActiveEpoch: catalogA.activeCatalog.epoch
  }), /simulated_active_catalog_write_failure/);

  assert.equal(store.getActivePricingCatalog().fingerprint, 'a'.repeat(64));
  assert.equal(store.getPricingMaintenanceState().catalogFingerprint, 'a'.repeat(64));
  assert.deepEqual(
    store.db.prepare(`
      SELECT model, input_cost_per_token, source
      FROM model_usage_pricing
      ORDER BY model
    `).all().map((row) => ({ ...row })),
    [
      {
        model: 'openai/gpt-removed',
        input_cost_per_token: 0.000007,
        source: catalogA.activeCatalog.source
      },
      {
        model: 'openai/gpt-standard',
        input_cost_per_token: 0.000001,
        source: catalogA.activeCatalog.source
      }
    ]
  );
});

test('maintenance batch rolls back costs when checkpoint persistence fails', (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-pricing-checkpoint-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = openModelUsageStore({
    fs,
    path,
    aiHomeDir: path.join(root, '.ai_home'),
    DatabaseSync
  });
  t.after(() => store.close());
  store.insertUsage({
    eventKey: 'pricing-checkpoint-rollback',
    provider: 'codex',
    model: 'gpt-standard',
    inputTokens: 1_000_000,
    costUsd: 99,
    timestampMs: new Date(2026, 6, 16, 12).getTime()
  });
  const catalog = activateTestCatalog(store, 'a'.repeat(64), 0.000001);
  store.db.exec(`
    CREATE TRIGGER fail_maintenance_checkpoint_write
    BEFORE UPDATE ON app_kv
    WHEN NEW.key = 'maintenance:model_usage_pricing'
    BEGIN
      SELECT RAISE(ABORT, 'simulated_maintenance_checkpoint_failure');
    END
  `);

  assert.throws(() => store.recalculatePricingMaintenanceBatch({
    expectedSource: catalog.activeCatalog.source,
    expectedEpoch: catalog.activeCatalog.epoch,
    batchSize: 1
  }), /simulated_maintenance_checkpoint_failure/);

  const usage = store.db.prepare(`
    SELECT cost_usd
    FROM model_usage_records
    WHERE event_key = 'pricing-checkpoint-rollback'
  `).get();
  const maintenance = store.getPricingMaintenanceState();
  assert.equal(Number(usage.cost_usd), 99);
  assert.equal(maintenance.cursorId, 0);
  assert.equal(maintenance.recalculated, 0);
  assert.equal(maintenance.status, 'pending');
});

test('model usage store exposes only epoch-guarded pricing maintenance mutations', (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-pricing-store-api-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = openModelUsageStore({
    fs,
    path,
    aiHomeDir: path.join(root, '.ai_home'),
    DatabaseSync
  });
  t.after(() => store.close());

  assert.equal(store.setPricingMaintenanceState, undefined);
  assert.equal(store.recalculateCosts, undefined);
  assert.equal(store.recalculateCostsBatch, undefined);
  assert.equal(store.upsertPricing([{
    model: 'openai/bootstrap',
    inputCostPerToken: 0.000001
  }], { source: 'test-bootstrap' }), 1);
  activateTestCatalog(store, 'a'.repeat(64), 0.000001);
  assert.throws(() => store.upsertPricing([{
    model: 'openai/forbidden',
    inputCostPerToken: 0.000001
  }], { source: 'test-bootstrap' }), /model_usage_pricing_catalog_active/);
});

test('a second service skips all-cost recalculation for the same bundled catalog', async (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-pricing-fingerprint-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const modelsDevDir = path.join(root, 'models.dev');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  writeModelPrice(modelsDevDir, 1, 2);

  const createService = () => createModelUsageService({
    fs,
    path,
    aiHomeDir,
    hostHomeDir: root,
    modelsDevDir,
    DatabaseSync
  });

  try {
    const firstService = createService();
    const firstSync = await firstService.syncPricingIfStale();
    assert.equal(firstSync.synced, true);
    assert.match(firstSync.catalogFingerprint, /^[a-f0-9]{64}$/);
    const timestampMs = new Date(2026, 6, 16, 12).getTime();
    firstService.recordUsage({
      eventKey: 'pricing-fingerprint-sentinel',
      provider: 'codex',
      model: 'gpt-standard',
      inputTokens: 1_000_000,
      costUsd: 123,
      timestampMs
    });

    const secondService = createService();
    const secondSync = await secondService.syncPricingIfStale();
    assert.equal(secondSync.synced, false);
    assert.equal(secondSync.reason, 'fresh');
    assert.equal(secondSync.catalogFingerprint, firstSync.catalogFingerprint);

    const db = new DatabaseSync(path.join(aiHomeDir, 'app-state.db'));
    try {
      const pricing = db.prepare(`
        SELECT source
        FROM model_usage_pricing
        WHERE model = 'openai/gpt-standard'
      `).get();
      const usage = db.prepare(`
        SELECT cost_usd
        FROM model_usage_records
        WHERE event_key = 'pricing-fingerprint-sentinel'
      `).get();
      assert.equal(
        pricing && pricing.source,
        `models.dev:${PRICING_CATALOG_FORMAT_VERSION}:${firstSync.catalogFingerprint}`
      );
      assert.equal(
        Number(usage && usage.cost_usd),
        123,
        'unchanged catalog must not trigger recalculateCosts({ all: true })'
      );
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a new model usage service refreshes bundled pricing only with explicit maintenance intent', async (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-pricing-refresh-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const modelsDevDir = path.join(root, 'models.dev');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  writeModelPrice(modelsDevDir, 1, 2);

  const createService = () => createModelUsageService({
    fs,
    path,
    aiHomeDir,
    hostHomeDir: root,
    modelsDevDir,
    DatabaseSync
  });

  try {
    const firstService = createService();
    const firstSync = await firstService.syncPricingIfStale();
    assert.equal(firstSync.synced, true);
    firstService.recordUsage({
      eventKey: 'pricing-refresh-event',
      provider: 'codex',
      model: 'gpt-standard',
      inputTokens: 1_000_000,
      timestampMs: new Date(2026, 6, 16, 12).getTime()
    });

    writeModelPrice(modelsDevDir, 3, 4);
    const restartedService = createService();
    const freshRead = await restartedService.syncPricingIfStale();
    assert.equal(freshRead.synced, false);
    assert.equal(freshRead.catalogFingerprint, firstSync.catalogFingerprint);

    const refreshed = await restartedService.syncPricingIfStale({ force: true });
    assert.equal(refreshed.synced, true);
    assert.equal(refreshed.recalculated, 0);
    assert.equal(refreshed.recalculationRequired, true);

    const maintenance = await restartedService.syncPricingIfStale({
      recalculateCosts: true
    });
    assert.equal(maintenance.recalculated, 1);
    assert.equal(maintenance.recalculationRequired, false);

    const query = {
      fromMs: new Date(2026, 6, 16).getTime(),
      toMs: new Date(2026, 6, 17).getTime() - 1
    };
    assert.equal(restartedService.getStats(query).totalCostUsd, 3);

    const fresh = await restartedService.syncPricingIfStale();
    assert.equal(fresh.synced, false);
    assert.equal(fresh.reason, 'fresh');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canonical attribution prices client tokens with the execution model', async (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-attribution-pricing-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const modelsDevDir = path.join(root, 'models.dev');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  writeGeminiFlashPrice(modelsDevDir);
  const service = createModelUsageService({
    fs,
    path,
    aiHomeDir,
    hostHomeDir: root,
    modelsDevDir,
    DatabaseSync
  });

  try {
    const sync = await service.syncPricingIfStale({ force: true });
    assert.equal(sync.synced, true);
    const timestampMs = new Date(2026, 6, 16, 12).getTime();
    service.recordUsageBatch([
      {
        eventKey: 'claude:file:unpriced-client-model:usage',
        provider: 'claude',
        sessionId: 'claude-priced-session',
        sourceKind: 'session_jsonl',
        model: 'unpriced-client-wire-model',
        inputTokens: 30,
        outputTokens: 12,
        totalTokens: 42,
        timestampMs
      },
      {
        eventKey: 'api:agy:priced-execution-model',
        provider: 'agy',
        sourceKind: 'server_code_assist_proxy',
        model: 'gemini-3-flash-a',
        inputTokens: 20,
        outputTokens: 7,
        cacheReadInputTokens: 10,
        reasoningOutputTokens: 5,
        totalTokens: 42,
        timestampMs: timestampMs + 200
      }
    ]);

    const query = {
      fromMs: new Date(2026, 6, 16).getTime(),
      toMs: new Date(2026, 6, 17).getTime() - 1
    };
    const rows = service.getCostByModel(query);
    assert.deepEqual(rows.map((row) => [row.provider, row.model, row.calls, row.totalTokens]), [
      ['claude', 'agy.gemini-3-flash-a', 1, 42]
    ]);
    assert.ok(Math.abs(rows[0].costUsd - 0.000153) < 1e-12);
    assert.ok(Math.abs(service.getStats(query).totalCostUsd - 0.000153) < 1e-12);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canonical attribution zeroes only unpriced cross-provider execution costs', (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-attribution-unpriced-'));
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const service = createModelUsageService({
    fs,
    path,
    aiHomeDir,
    hostHomeDir: root,
    DatabaseSync
  });

  try {
    const timestampMs = new Date(2026, 6, 16, 12).getTime();
    service.recordUsageBatch([
      {
        eventKey: 'claude:file:unpriced-cross-client:usage',
        provider: 'claude',
        sessionId: 'unpriced-cross-session',
        sourceKind: 'session_jsonl',
        model: 'client-model-with-stale-cost',
        inputTokens: 30,
        outputTokens: 7,
        costUsd: 7,
        timestampMs
      },
      {
        eventKey: 'api:agy:unpriced-cross-execution',
        provider: 'agy',
        sourceKind: 'server_code_assist_proxy',
        model: 'unknown-execution-model',
        inputTokens: 30,
        outputTokens: 7,
        costUsd: 9,
        timestampMs: timestampMs + 100
      },
      {
        eventKey: 'claude:file:unpriced-native-client:usage',
        provider: 'claude',
        sessionId: 'unpriced-native-session',
        sourceKind: 'session_jsonl',
        model: 'unknown-native-model',
        inputTokens: 11,
        outputTokens: 3,
        costUsd: 5,
        timestampMs: timestampMs + 10_000
      },
      {
        eventKey: 'api:claude:unpriced-native-proxy',
        provider: 'claude',
        sourceKind: 'server_proxy',
        model: 'unknown-native-model',
        inputTokens: 11,
        outputTokens: 3,
        costUsd: 6,
        timestampMs: timestampMs + 10_100
      }
    ]);

    const rows = service.getCostByModel({
      fromMs: new Date(2026, 6, 16).getTime(),
      toMs: new Date(2026, 6, 17).getTime() - 1
    });
    assert.deepEqual(rows.map((row) => [row.provider, row.model, row.calls, row.costUsd]), [
      ['claude', 'unknown-native-model', 1, 5],
      ['claude', 'agy.unknown-execution-model', 1, 0]
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bundled models.dev exposes current GPT-5.6 Sol and Gemini 3.5 Flash prices', () => {
  const pricing = Object.fromEntries(
    buildModelsDevPricingRecords({ modelsDevDir: DEFAULT_MODELS_DEV_DIR })
      .map((record) => [record.model, record])
  );

  assert.deepEqual(pricing['openai/gpt-5.6-sol'], {
    model: 'openai/gpt-5.6-sol',
    inputCostPerToken: 0.000005,
    outputCostPerToken: 0.00003,
    cacheReadInputTokenCost: 0.0000005,
    cacheCreationInputTokenCost: 0.00000625,
    contextCostTiers: [{
      size: 272000,
      inputCostPerToken: 0.00001,
      outputCostPerToken: 0.000045,
      cacheReadInputTokenCost: 0.000001,
      cacheCreationInputTokenCost: 0.0000125
    }]
  });
  assert.deepEqual(pricing['google/gemini-3.5-flash'], {
    model: 'google/gemini-3.5-flash',
    inputCostPerToken: 0.0000015,
    outputCostPerToken: 0.000009,
    cacheReadInputTokenCost: 0.00000015
  });
});
