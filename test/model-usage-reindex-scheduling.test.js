'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createModelUsageScanScheduler } = require('../lib/usage/model-usage-scheduler');
const { createModelUsageService } = require('../lib/usage/model-usage-service');
const { openModelUsageStore } = require('../lib/usage/model-usage-store');
const { scanModelUsageSources } = require('../lib/usage/model-usage-scanner');
const {
  createModelUsageAccountingService,
  parseModelUsageArgs
} = require('../lib/cli/services/usage/model-accounting');

function requireDatabaseSync(t) {
  try {
    return require('node:sqlite').DatabaseSync;
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return null;
  }
}

function writeLegacyForkFixture(root) {
  const filePath = path.join(
    root,
    '.codex',
    'sessions',
    '2026',
    '07',
    '16',
    'rollout-legacy-fork.jsonl'
  );
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const sessionMeta = JSON.stringify({
    timestamp: '2026-07-16T06:08:42.998Z',
    type: 'session_meta',
    payload: {
      id: '019f698a-a7b0-7041-b4a2-41cfb5f0de48',
      cwd: '/work/child',
      forked_from_id: '019f522d-bc5c-75d2-a42c-cbf33a7b706a'
    }
  });
  const inheritedPayload = JSON.stringify({
    timestamp: '2026-07-16T06:08:43.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'x'.repeat(1024 * 1024) }]
    }
  });
  fs.writeFileSync(filePath, `${sessionMeta}\n${inheritedPayload}\n`, 'utf8');
  return filePath;
}

test('background model usage scans explicitly disable historical Codex fork reindex', async () => {
  const scanOptions = [];
  const scheduler = createModelUsageScanScheduler({
    modelUsageService: {
      scan: (options) => {
        scanOptions.push(options);
        return { files: 0 };
      }
    }
  });

  const result = await scheduler.runScanNow('startup');

  assert.equal(result.ok, true);
  assert.deepEqual(scanOptions, [{ reindexCodexForkHistory: false }]);
});

test('Codex fork reindex is available only through the explicit usage scan flag', () => {
  assert.equal(
    parseModelUsageArgs(['scan', '--reindex-codex-forks']).reindexCodexForkHistory,
    true
  );
  assert.throws(
    () => parseModelUsageArgs(['stats', '--reindex-codex-forks']),
    /仅支持 usage scan/
  );
  assert.throws(
    () => parseModelUsageArgs([
      'scan',
      '--provider',
      'claude',
      '--reindex-codex-forks'
    ]),
    /仅支持 codex provider/
  );
});

test('model usage CLI forwards Codex fork reindex only from the explicit maintenance flag', async () => {
  assert.equal(
    parseModelUsageArgs(['scan', '--reindex-codex-forks']).reindexCodexForkHistory,
    true
  );

  const scanOptions = [];
  const accounting = createModelUsageAccountingService({
    modelUsageService: {
      scan: (options) => {
        scanOptions.push(options);
        return {
          providers: {},
          files: 0,
          records: 0,
          prompts: 0,
          skipped: 0,
          filesDeferred: 0,
          reindexRequired: 0
        };
      }
    },
    log: () => {}
  });

  await accounting.printModelUsageReport(['scan']);
  await accounting.printModelUsageReport(['scan', '--reindex-codex-forks']);

  assert.deepEqual(scanOptions, [
    { provider: '', reindexCodexForkHistory: false },
    { provider: 'codex', reindexCodexForkHistory: true }
  ]);
});

test('model usage cost maintenance is an explicit local CLI command', async () => {
  const pricingOptions = [];
  let scans = 0;
  const accounting = createModelUsageAccountingService({
    modelUsageService: {
      syncPricingIfStale: async (options) => {
        pricingOptions.push(options);
        return {
          ok: true,
          synced: false,
          recalculated: 7,
          recalculationRequired: false
        };
      },
      scan: () => {
        scans += 1;
        return {};
      }
    },
    log: () => {}
  });

  await accounting.printModelUsageReport(['recalculate-costs']);

  assert.deepEqual(pricingOptions, [{ recalculateCosts: true }]);
  assert.equal(scans, 0);
});

test('model usage service forwards explicit Codex fork maintenance to the scanner', (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-usage-service-reindex-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const filePath = writeLegacyForkFixture(root);
  const fileSize = fs.statSync(filePath).size;
  const seedStore = openModelUsageStore({ fs, path, aiHomeDir, DatabaseSync });
  assert.ok(seedStore);
  seedStore.setFileState(filePath, {
    size: fileSize,
    offset: fileSize,
    scanContext: {
      sessionId: '019f698a-a7b0-7041-b4a2-41cfb5f0de48',
      cwd: '/work/child',
      model: 'gpt-5.6-sol'
    }
  });
  seedStore.close();

  const service = createModelUsageService({
    fs,
    path,
    aiHomeDir,
    hostHomeDir: root,
    DatabaseSync
  });
  const deferred = service.scan({ provider: 'codex' });
  assert.equal(deferred.reindexRequired, 1);

  const maintenance = service.scan({
    provider: 'codex',
    reindexCodexForkHistory: true
  });

  assert.equal(maintenance.reindexRequired, 0);
  const rebuiltStore = openModelUsageStore({ fs, path, aiHomeDir, DatabaseSync });
  const rebuiltState = rebuiltStore.getFileState(filePath);
  rebuiltStore.close();
  assert.equal(rebuiltState.scanContext.codexScanContextVersion, 2);
});

test('model usage CLI reports deferred fork files and required maintenance', async () => {
  const logs = [];
  const accounting = createModelUsageAccountingService({
    modelUsageService: {
      scan: () => ({
        providers: {
          codex: {
            files: 12,
            records: 0,
            prompts: 0,
            skipped: 0,
            filesDeferred: 3,
            reindexRequired: 3,
            reason: 'codex_fork_reindex_required'
          }
        },
        files: 12,
        records: 0,
        prompts: 0,
        skipped: 0,
        filesDeferred: 3,
        reindexRequired: 3
      })
    },
    log: (line) => logs.push(line)
  });

  await accounting.printModelUsageReport(['scan']);

  assert.equal(logs.some((line) => line.includes('filesDeferred=3')), true);
  assert.equal(logs.some((line) => line.includes('reindexRequired=3')), true);
  assert.equal(logs.some((line) => line.includes('codex_fork_reindex_required')), true);
});

test('legacy Codex fork history is deferred until an explicit maintenance scan', (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-usage-reindex-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const filePath = writeLegacyForkFixture(root);
  const fileSize = fs.statSync(filePath).size;

  const seedStore = openModelUsageStore({ fs, path, aiHomeDir, DatabaseSync });
  assert.ok(seedStore);
  seedStore.setFileState(filePath, {
    size: fileSize,
    offset: fileSize,
    scanContext: {
      sessionId: '019f698a-a7b0-7041-b4a2-41cfb5f0de48',
      cwd: '/work/child',
      model: 'gpt-5.6-sol'
    }
  });
  seedStore.close();

  let bytesRead = 0;
  const measuredFs = Object.create(fs);
  measuredFs.readSync = (...args) => {
    const count = fs.readSync(...args);
    bytesRead += count;
    return count;
  };
  function scan(options = {}) {
    const store = openModelUsageStore({ fs, path, aiHomeDir, DatabaseSync });
    assert.ok(store);
    try {
      return scanModelUsageSources({
        fs: measuredFs,
        path,
        store,
        hostHomeDir: root,
        providers: ['codex'],
        ...options
      });
    } finally {
      store.close();
    }
  }

  const incremental = scan();

  assert.equal(incremental.providers.codex.filesDeferred, 1);
  assert.equal(incremental.providers.codex.reindexRequired, 1);
  assert.equal(incremental.providers.codex.reason, 'codex_fork_reindex_required');
  assert.ok(
    bytesRead < 64 * 1024,
    `incremental scan synchronously read ${bytesRead} bytes from ${fileSize}-byte fork history`
  );

  const deferredStore = openModelUsageStore({ fs, path, aiHomeDir, DatabaseSync });
  const deferredState = deferredStore.getFileState(filePath);
  deferredStore.close();
  assert.equal(deferredState.offset, fileSize);
  assert.notEqual(deferredState.scanContext.codexScanContextVersion, 2);

  bytesRead = 0;
  const maintenance = scan({ reindexCodexForkHistory: true });

  assert.equal(maintenance.providers.codex.filesDeferred, 0);
  assert.equal(maintenance.providers.codex.reindexRequired, 0);
  assert.ok(bytesRead >= fileSize, 'maintenance scan did not read the historical fork payload');

  const rebuiltStore = openModelUsageStore({ fs, path, aiHomeDir, DatabaseSync });
  const rebuiltState = rebuiltStore.getFileState(filePath);
  rebuiltStore.close();
  assert.equal(rebuiltState.offset, fileSize);
  assert.equal(rebuiltState.scanContext.codexScanContextVersion, 2);
});
