'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createModelUsageService } = require('../lib/usage/model-usage-service');
const { openModelUsageStore } = require('../lib/usage/model-usage-store');

const DAY_MS = 24 * 60 * 60 * 1000;

function emptyStats(overrides = {}) {
  return {
    totalCalls: 0,
    totalSessions: 0,
    totalPrompts: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    ...overrides
  };
}

function modelRow(model, overrides = {}) {
  const row = {
    provider: 'codex',
    model,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    accountCount: 0,
    unattributedCalls: 0,
    ...overrides
  };
  const totalInput = row.inputTokens + row.cacheReadInputTokens + row.cacheCreationInputTokens;
  return {
    ...row,
    cacheHitRate: totalInput > 0 ? row.cacheReadInputTokens / totalInput : null
  };
}

function sessionPart(sessionId, overrides = {}) {
  return {
    provider: 'codex',
    sessionId,
    usageProject: '',
    sessionProject: '',
    usageCwd: '',
    sessionCwd: '',
    usageGitBranch: '',
    sessionGitBranch: '',
    usageStartedAtMs: 0,
    sessionStartedAtMs: 0,
    usageUpdatedAtMs: 0,
    sessionUpdatedAtMs: 0,
    promptCount: 0,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    unattributedCalls: 0,
    accountRefs: [],
    ...overrides
  };
}

test('progressive dashboard prepares attribution once, bounds concurrency and merges exact shard state', async () => {
  const fromMs = Date.UTC(2026, 5, 1);
  const toMs = fromMs + 3 * DAY_MS - 1;
  const day2Start = fromMs + DAY_MS;
  const day3Start = fromMs + 2 * DAY_MS;
  const crossBoundaryAttribution = {
    scannerId: 10,
    proxyId: 11,
    scannerTimestampMs: day3Start - 250,
    proxyTimestampMs: day3Start + 250,
    model: 'gpt-5.1-codex',
    costUsd: 1
  };
  const oldestAttribution = {
    scannerId: 20,
    proxyId: 21,
    scannerTimestampMs: fromMs + 100,
    proxyTimestampMs: fromMs + 200,
    model: 'gpt-5.2-codex',
    costUsd: 2
  };
  const outsideAttribution = {
    scannerId: 30,
    proxyId: 31,
    scannerTimestampMs: toMs + DAY_MS,
    proxyTimestampMs: toMs + DAY_MS + 100,
    model: 'outside',
    costUsd: 3
  };
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const executor = {
    getState: () => ({ concurrency: 2 }),
    execute: async (method, query) => {
      calls.push({ method, query });
      if (method === 'prepareDashboardQuery') {
        return {
          forkDescriptors: [{ sourceHash: '0123456789abcdef' }],
          attributions: [crossBoundaryAttribution, oldestAttribution, outsideAttribution]
        };
      }
      assert.equal(method, 'getDashboardShard');
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, query.fromMs === day2Start ? 20 : 10));
      active -= 1;

      if (query.fromMs === day3Start) {
        return {
          stats: emptyStats({ totalCalls: 1, totalPrompts: 1, inputTokens: 6, outputTokens: 4, totalTokens: 10, totalCostUsd: 1 }),
          models: [modelRow('gpt-5.1-codex', { calls: 1, inputTokens: 6, outputTokens: 4, totalTokens: 10, costUsd: 1 })],
          modelOptions: [modelRow('gpt-5.1-codex', { calls: 1, inputTokens: 6, outputTokens: 4, totalTokens: 10, costUsd: 1 })],
          sessionParts: [sessionPart('shared', {
            sessionProject: 'session-meta-z',
            usageStartedAtMs: day3Start + 100,
            sessionStartedAtMs: fromMs - 1_000,
            usageUpdatedAtMs: day3Start + 100,
            promptCount: 1,
            calls: 1,
            totalTokens: 10,
            costUsd: 1
          })]
        };
      }
      if (query.fromMs === day2Start) {
        return {
          stats: emptyStats({ totalCalls: 2, totalPrompts: 2, inputTokens: 12, outputTokens: 8, totalTokens: 20, totalCostUsd: 2 }),
          models: [modelRow('gpt-5.1-codex', { calls: 2, inputTokens: 12, outputTokens: 8, totalTokens: 20, costUsd: 2 })],
          modelOptions: [modelRow('gpt-5.1-codex', { calls: 2, inputTokens: 12, outputTokens: 8, totalTokens: 20, costUsd: 2 })],
          sessionParts: [sessionPart('shared', {
            usageProject: 'usage-project-a',
            sessionProject: 'session-meta-z',
            usageCwd: '/work/a',
            sessionCwd: '/work/meta-z',
            usageGitBranch: 'main',
            sessionGitBranch: 'z-meta',
            usageStartedAtMs: day2Start + 100,
            sessionStartedAtMs: fromMs - 1_000,
            usageUpdatedAtMs: day2Start + 200,
            promptCount: 2,
            calls: 2,
            totalTokens: 20,
            costUsd: 2
          })]
        };
      }
      return {
        stats: emptyStats({ totalCalls: 1, totalPrompts: 3, inputTokens: 3, outputTokens: 2, totalTokens: 5, totalCostUsd: 0.5 }),
        models: [modelRow('gpt-5.2-codex', { calls: 1, inputTokens: 3, outputTokens: 2, totalTokens: 5, costUsd: 0.5 })],
        modelOptions: [modelRow('gpt-5.2-codex', { calls: 1, inputTokens: 3, outputTokens: 2, totalTokens: 5, costUsd: 0.5 })],
        sessionParts: [sessionPart('oldest', {
          usageProject: 'old-project',
          usageStartedAtMs: fromMs + 100,
          usageUpdatedAtMs: fromMs + 200,
          promptCount: 3,
          calls: 1,
          totalTokens: 5,
          costUsd: 0.5
        })]
      };
    }
  };
  const service = createModelUsageService({ queryExecutor: executor });
  const progress = [];

  const dashboard = await service.getDashboardProgressive({
    fromMs,
    toMs,
    provider: 'codex',
    limit: 50
  }, {
    onProgress: (update) => progress.push(update)
  });

  assert.equal(calls.filter((call) => call.method === 'prepareDashboardQuery').length, 1);
  assert.equal(calls.filter((call) => call.method === 'getDashboardShard').length, 3);
  assert.equal(maxActive, 2);
  assert.equal(progress.length, 3);
  assert.deepEqual(progress.map((item) => item.completedShards), [1, 2, 3]);
  assert.deepEqual(progress.map((item) => item.totalShards), [3, 3, 3]);
  assert.equal(progress[2].dashboard.stats.totalCalls, 4);

  const shardCalls = calls.filter((call) => call.method === 'getDashboardShard');
  assert.deepEqual(shardCalls.slice(0, 2).map((call) => call.query.fromMs), [day3Start, day2Start]);
  const attributionIdsByShard = Object.fromEntries(shardCalls.map((call) => [
    call.query.fromMs,
    call.query.projectionContext.attributions.map((item) => item.scannerId)
  ]));
  assert.deepEqual(attributionIdsByShard[day3Start], [10]);
  assert.deepEqual(attributionIdsByShard[day2Start], [10]);
  assert.deepEqual(attributionIdsByShard[fromMs], [20]);

  assert.deepEqual(dashboard.stats, emptyStats({
    totalCalls: 4,
    totalSessions: 2,
    totalPrompts: 6,
    inputTokens: 21,
    outputTokens: 14,
    totalTokens: 35,
    totalCostUsd: 3.5
  }));
  assert.deepEqual(dashboard.models, [
    modelRow('gpt-5.1-codex', { calls: 3, inputTokens: 18, outputTokens: 12, totalTokens: 30, costUsd: 3 }),
    modelRow('gpt-5.2-codex', { calls: 1, inputTokens: 3, outputTokens: 2, totalTokens: 5, costUsd: 0.5 })
  ]);
  assert.deepEqual(dashboard.sessions, [{
    provider: 'codex',
    sessionId: 'shared',
    project: 'usage-project-a',
    cwd: '/work/a',
    gitBranch: 'main',
    startedAtMs: fromMs - 1_000,
    updatedAtMs: day3Start + 100,
    promptCount: 3,
    calls: 3,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 30,
    costUsd: 3,
    accountCount: 0,
    unattributedCalls: 0,
    cacheHitRate: null
  }, {
    provider: 'codex',
    sessionId: 'oldest',
    project: 'old-project',
    cwd: '',
    gitBranch: '',
    startedAtMs: fromMs + 100,
    updatedAtMs: fromMs + 200,
    promptCount: 3,
    calls: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 5,
    costUsd: 0.5,
    accountCount: 0,
    unattributedCalls: 0,
    cacheHitRate: null
  }]);
  assert.deepEqual(dashboard.modelOptions, dashboard.models);
});

test('progressive dashboard cancellation stops dispatching shards that have not started', async () => {
  const fromMs = Date.UTC(2026, 5, 1);
  let releaseShard;
  const shardCalls = [];
  const executor = {
    getState: () => ({ concurrency: 1 }),
    execute: async (method, query) => {
      if (method === 'prepareDashboardQuery') return { forkDescriptors: [], attributions: [] };
      shardCalls.push(query);
      await new Promise((resolve) => { releaseShard = resolve; });
      return { stats: emptyStats(), models: [], modelOptions: [], sessionParts: [] };
    }
  };
  const service = createModelUsageService({ queryExecutor: executor });
  const controller = new AbortController();
  const pending = service.getDashboardProgressive({
    fromMs,
    toMs: fromMs + 3 * DAY_MS - 1
  }, { signal: controller.signal });

  while (!releaseShard) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  releaseShard();

  await assert.rejects(pending, (error) => error && error.code === 'model_usage_query_cancelled');
  assert.equal(shardCalls.length, 1);
});

test('progressive dashboard matches the complete canonical query across a shard boundary', async (t) => {
  let DatabaseSync;
  try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-usage-progressive-'));
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const service = createModelUsageService({
    fs,
    path,
    aiHomeDir,
    hostHomeDir: root,
    DatabaseSync,
    queryWorkerOptions: { concurrency: 2, timeoutMs: 10_000 }
  });
  t.after(async () => {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const fromMs = Date.UTC(2026, 5, 1);
  const boundaryMs = fromMs + DAY_MS;
  const toMs = fromMs + 2 * DAY_MS - 1;
  service.recordUsageBatch([{
    eventKey: 'scanner-across-shard-boundary',
    provider: 'codex',
    sessionId: 'cross-boundary-session',
    sourceKind: 'session_jsonl',
    model: 'gpt-5.1-codex',
    inputTokens: 10,
    outputTokens: 5,
    timestampMs: boundaryMs - 250,
    project: 'cross-project'
  }, {
    eventKey: 'proxy-across-shard-boundary',
    provider: 'codex',
    sessionId: 'cross-boundary-session',
    sourceKind: 'server_codex_proxy',
    model: 'gpt-5.1-codex',
    inputTokens: 10,
    outputTokens: 5,
    timestampMs: boundaryMs + 250
  }, {
    eventKey: 'independent-oldest',
    provider: 'codex',
    sessionId: 'oldest-session',
    sourceKind: 'server_codex_proxy',
    model: 'gpt-5.2-codex',
    inputTokens: 3,
    outputTokens: 2,
    timestampMs: fromMs + 1_000
  }, {
    eventKey: 'independent-latest',
    provider: 'codex',
    sessionId: 'latest-session',
    sourceKind: 'server_codex_proxy',
    model: 'gpt-5.3-codex',
    inputTokens: 6,
    outputTokens: 4,
    timestampMs: toMs - 1_000
  }]);
  const query = { fromMs, toMs, provider: 'codex', limit: 50 };
  const expected = service.getDashboard(query);
  const progress = [];

  const actual = await service.getDashboardProgressive(query, {
    onProgress: (update) => progress.push(update)
  });

  assert.deepEqual(actual, expected);
  assert.equal(progress.length, 2);
  assert.deepEqual(progress.map((item) => item.completedShards), [1, 2]);
  assert.deepEqual(progress[1].dashboard, expected);
});

test('dashboard monetary aggregates use deterministic sub-cent precision', (t) => {
  let DatabaseSync;
  try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-usage-cost-precision-'));
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const service = createModelUsageService({
    fs,
    path,
    aiHomeDir,
    hostHomeDir: root,
    DatabaseSync,
    enableAsyncQueries: false
  });
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const fromMs = Date.UTC(2026, 5, 1);
  service.recordUsageBatch([9759.884522944001].map((costUsd, index) => ({
    eventKey: `cost-precision-${index}`,
    provider: 'codex',
    sessionId: 'cost-precision-session',
    sourceKind: 'server_codex_proxy',
    model: 'unpriced-cost-precision-model',
    inputTokens: 1,
    costUsd,
    timestampMs: fromMs + index * DAY_MS
  })));

  const dashboard = service.getDashboard({
    fromMs,
    toMs: fromMs + 3 * DAY_MS - 1,
    provider: 'codex'
  });

  assert.equal(dashboard.stats.totalCostUsd, 9759.884522944);
  assert.equal(dashboard.models[0].costUsd, 9759.884522944);
  assert.equal(dashboard.sessions[0].costUsd, 9759.884522944);
});

test('prepared dashboard context freezes usage and prompt high-water marks', (t) => {
  let DatabaseSync;
  try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-usage-high-water-'));
  const aiHomeDir = path.join(root, '.ai_home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const service = createModelUsageService({
    fs,
    path,
    aiHomeDir,
    hostHomeDir: root,
    DatabaseSync,
    enableAsyncQueries: false
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fromMs = Date.UTC(2026, 5, 1);
  const query = { fromMs, toMs: fromMs + DAY_MS - 1, provider: 'codex' };
  service.recordUsage({
    eventKey: 'high-water-initial-usage',
    provider: 'codex',
    sessionId: 'high-water-session',
    sourceKind: 'server_codex_proxy',
    model: 'gpt-5.1-codex',
    inputTokens: 1,
    timestampMs: fromMs + 100
  });
  const initialStore = openModelUsageStore({ fs, path, aiHomeDir, DatabaseSync });
  initialStore.insertPromptEvents([{
    eventKey: 'high-water-initial-prompt',
    provider: 'codex',
    sessionId: 'high-water-session',
    timestampMs: fromMs + 100
  }]);
  initialStore.close();

  const projectionContext = service.prepareDashboardQuery(query);
  assert.equal(projectionContext.recordHighWaterId > 0, true);
  assert.equal(projectionContext.promptHighWaterRowId > 0, true);

  service.recordUsage({
    eventKey: 'high-water-late-usage',
    provider: 'codex',
    sessionId: 'high-water-session',
    sourceKind: 'server_codex_proxy',
    model: 'gpt-5.1-codex',
    inputTokens: 1,
    timestampMs: fromMs + 200
  });
  const lateStore = openModelUsageStore({ fs, path, aiHomeDir, DatabaseSync });
  lateStore.insertPromptEvents([{
    eventKey: 'high-water-late-prompt',
    provider: 'codex',
    sessionId: 'high-water-session',
    timestampMs: fromMs + 200
  }]);
  lateStore.close();

  const shard = service.getDashboardShard({ ...query, projectionContext });

  assert.equal(shard.stats.totalCalls, 1);
  assert.equal(shard.stats.totalPrompts, 1);
});
