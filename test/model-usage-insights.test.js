'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createModelUsageService } = require('../lib/usage/model-usage-service');
const { calculateCacheHitRate } = require('../lib/usage/model-usage-metrics');
const { MAX_TREND_POINTS } = require('../lib/usage/model-usage-trend');

const ACCOUNT_A = 'acct_11111111111111111111';
const ACCOUNT_B = 'acct_22222222222222222222';

function createFixture(t) {
  let DatabaseSync;
  try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return null;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-model-usage-insights-'));
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
  return { service };
}

test('cache hit rate uses cache reads over all input-side tokens', () => {
  assert.equal(calculateCacheHitRate({
    inputTokens: 100,
    cacheReadInputTokens: 300,
    cacheCreationInputTokens: 100
  }), 0.6);
  assert.equal(calculateCacheHitRate({ outputTokens: 10 }), null);
});

test('model usage dashboard exposes bounded trends and exact model/session account counts', async (t) => {
  const fixture = createFixture(t);
  if (!fixture) return;
  const { service } = fixture;
  const fromMs = Date.parse('2026-08-20T00:00:00.000Z');
  const toMs = fromMs + 2 * 60 * 60 * 1000 - 1;
  service.recordUsageBatch([
    {
      eventKey: 'insight-account-a',
      provider: 'codex',
      accountRef: ACCOUNT_A,
      sessionId: 'session-shared',
      sourceKind: 'server_codex_proxy',
      model: 'gpt-insight',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 100,
      totalTokens: 520,
      costUsd: 1,
      timestampMs: fromMs + 5 * 60 * 1000
    },
    {
      eventKey: 'insight-account-b',
      provider: 'codex',
      accountRef: ACCOUNT_B,
      sessionId: 'session-shared',
      sourceKind: 'server_codex_proxy',
      model: 'gpt-insight',
      inputTokens: 200,
      outputTokens: 40,
      cacheReadInputTokens: 200,
      totalTokens: 440,
      costUsd: 2,
      timestampMs: fromMs + 65 * 60 * 1000
    },
    {
      eventKey: 'insight-unattributed',
      provider: 'codex',
      sessionId: 'session-shared',
      sourceKind: 'session_jsonl',
      model: 'gpt-insight',
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 60,
      costUsd: 0.5,
      timestampMs: fromMs + 70 * 60 * 1000
    }
  ]);
  const query = { fromMs, toMs, provider: 'codex', limit: 50 };

  const direct = service.getDashboard(query);
  const progressive = await service.getDashboardProgressive(query);
  assert.deepEqual(progressive, direct);

  assert.ok(direct.trend.points.length > 0);
  assert.ok(direct.trend.points.length <= MAX_TREND_POINTS);
  assert.equal(
    direct.trend.points.reduce((total, point) => total + point.totalTokens, 0),
    direct.stats.totalTokens
  );
  assert.equal(
    direct.trend.points.reduce((total, point) => total + point.calls, 0),
    direct.stats.totalCalls
  );

  assert.equal(direct.models.length, 1);
  assert.equal(direct.models[0].accountCount, 2);
  assert.equal(direct.models[0].unattributedCalls, 1);
  assert.equal(direct.models[0].cacheHitRate, 500 / 950);

  assert.equal(direct.sessions.length, 1);
  assert.equal(direct.sessions[0].accountCount, 2);
  assert.equal(direct.sessions[0].unattributedCalls, 1);
  assert.equal(direct.sessions[0].inputTokens, 350);
  assert.equal(direct.sessions[0].outputTokens, 70);
  assert.equal(direct.sessions[0].cacheReadInputTokens, 500);
  assert.equal(direct.sessions[0].cacheCreationInputTokens, 100);
  assert.equal(direct.sessions[0].cacheHitRate, 500 / 950);

  const sessionDetail = service.getSessionDetail({
    ...query,
    sessionId: 'session-shared'
  });
  assert.equal(sessionDetail.length, 1);
  assert.equal(sessionDetail[0].accountCount, 2);
  assert.equal(sessionDetail[0].unattributedCalls, 1);

  const breakdown = await service.getBreakdownAsync({
    ...query,
    sessionId: 'session-shared'
  });
  assert.equal(breakdown.accounts.length, 3);
  const accountA = breakdown.accounts.find((row) => row.accountRef === ACCOUNT_A);
  const accountB = breakdown.accounts.find((row) => row.accountRef === ACCOUNT_B);
  const unattributed = breakdown.accounts.find((row) => row.accountRef === '');
  assert.equal(accountA.accountProvider, 'codex');
  assert.equal(accountA.totalTokens, 520);
  assert.equal(accountA.cacheHitRate, 0.6);
  assert.equal(accountB.totalTokens, 440);
  assert.equal(unattributed.totalTokens, 60);
  assert.equal(unattributed.accountProvider, '');
});

test('canonical attribution carries the exact proxy account into the matched session row', async (t) => {
  const fixture = createFixture(t);
  if (!fixture) return;
  const { service } = fixture;
  const timestampMs = Date.parse('2026-08-20T10:00:00.000Z');
  service.recordUsageBatch([
    {
      eventKey: 'claude:file:account-attribution:usage',
      provider: 'claude',
      sessionId: 'cross-provider-session',
      sourceKind: 'session_jsonl',
      model: 'gemini-3-flash-agent',
      inputTokens: 30,
      outputTokens: 7,
      totalTokens: 37,
      costUsd: 0.25,
      timestampMs
    },
    {
      eventKey: 'api:agy:account-attribution',
      provider: 'agy',
      accountRef: ACCOUNT_B,
      sessionId: 'cross-provider-session',
      sourceKind: 'server_code_assist_proxy',
      model: 'gemini-3-flash-agent',
      inputTokens: 30,
      outputTokens: 7,
      reasoningOutputTokens: 5,
      totalTokens: 42,
      costUsd: 0.4,
      timestampMs: timestampMs + 250
    }
  ]);
  const query = {
    fromMs: timestampMs - 1_000,
    toMs: timestampMs + 1_000,
    provider: 'claude',
    sessionId: 'cross-provider-session'
  };

  const breakdown = await service.getBreakdownAsync(query);
  assert.equal(breakdown.summary.calls, 1);
  assert.equal(breakdown.accounts.length, 1);
  assert.equal(breakdown.accounts[0].accountRef, ACCOUNT_B);
  assert.equal(breakdown.accounts[0].accountProvider, 'agy');
  assert.equal(breakdown.accounts[0].totalTokens, 37);
  assert.equal(breakdown.models[0].provider, 'claude');
  assert.equal(breakdown.models[0].model, 'agy.gemini-3-flash-agent');
  assert.equal(breakdown.models[0].accountCount, 1);
});
