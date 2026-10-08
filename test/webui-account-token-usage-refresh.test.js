'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createModelUsageService } = require('../lib/usage/model-usage-service');
const { emitAccountTokenConsumedEvent, updateCachedAccountTokenUsage } = require('../lib/server/webui-account-live');
const { readAccountTokenUsageCache } = require('../lib/server/webui-account-token-usage-cache');

const GROK_REF = 'acct_1234567890abcdef1234';
const CODEX_REF = 'acct_abcdef1234567890abcd';

function tokens(total) {
  return { day: total, week: total, month: total, total, models: [] };
}

test('provider-scoped account token queries use the same sync and worker contract', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-provider-token-query-'));
  const service = createModelUsageService({ fs, path, hostHomeDir: root, aiHomeDir: root });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const nowMs = Date.now();
  service.recordUsageBatch([
    { eventKey: 'grok-bill', provider: 'grok', accountRef: GROK_REF, model: 'grok-4.7', totalTokens: 17968, timestampMs: nowMs - 1 },
    { eventKey: 'codex-bill', provider: 'codex', accountRef: CODEX_REF, model: 'gpt-5', totalTokens: 100000, timestampMs: nowMs - 1 }
  ]);
  const scoped = service.getAccountTokenUsage({ provider: 'grok', nowMs });
  assert.deepEqual(Object.keys(scoped), [GROK_REF]);
  assert.equal(scoped[GROK_REF].total, 17968);
  assert.deepEqual(await service.getAccountTokenUsageAsync({ provider: 'grok', nowMs }), scoped);
  assert.equal(Object.keys(service.getAccountTokenUsage({ nowMs })).length, 2);
});

test('Grok scoped cache refresh preserves other provider totals and pending gateway deltas', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-scoped-token-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const frames = [];
  const state = { __webUiAccountsLive: {
    records: new Map([
      [GROK_REF, { provider: 'grok', accountRef: GROK_REF, tokenUsage: tokens(100) }],
      [CODEX_REF, { provider: 'codex', accountRef: CODEX_REF, tokenUsage: tokens(200) }]
    ]),
    watchers: new Set(),
    webSocketWatchers: new Set([{ client: { readyState: 1, send: (frame) => frames.push(JSON.parse(frame)) } }]),
    loadedFromDisk: false, revision: 0
  } };
  const ctx = { state, fs, aiHomeDir: root };
  const at = Date.now() - 1000;
  updateCachedAccountTokenUsage(ctx, { [GROK_REF]: tokens(100), [CODEX_REF]: tokens(200) }, { generatedAt: at });
  emitAccountTokenConsumedEvent(state, {
    provider: 'codex', accountRef: CODEX_REF, model: 'gpt-5',
    usage: { total_tokens: 50 }, timestampMs: at + 1
  });
  frames.length = 0;

  updateCachedAccountTokenUsage(ctx, { [GROK_REF]: tokens(17968) }, { provider: 'grok', generatedAt: at + 2 });
  const live = state.__webUiAccountsLive;
  assert.equal(live.records.get(GROK_REF).tokenUsage.total, 17968);
  assert.equal(live.records.get(CODEX_REF).tokenUsage.total, 250);
  assert.equal(live.pendingTokenUsage.get(CODEX_REF).length, 1);
  assert.deepEqual(frames.filter((event) => event.type === 'account').map((event) => event.account.accountRef), [GROK_REF]);
  assert.equal(readAccountTokenUsageCache(ctx).accounts[CODEX_REF].total, 200);

  live.tokenUsage.expiresAt = 0;
  updateCachedAccountTokenUsage(ctx, { [GROK_REF]: tokens(100), [CODEX_REF]: tokens(350) }, { generatedAt: at + 1 });
  assert.equal(live.records.get(GROK_REF).tokenUsage.total, 17968);
  assert.equal(live.records.get(CODEX_REF).tokenUsage.total, 350);
  updateCachedAccountTokenUsage(ctx, { [GROK_REF]: tokens(17968), [CODEX_REF]: tokens(350) }, { generatedAt: at + 3 });
  assert.equal(live.pendingTokenUsage.size, 0);
  assert.equal(live.records.get(CODEX_REF).tokenUsage.total, 350);
});

test('Grok scoped cache refresh clears a removed bill without clearing another provider', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-scoped-token-clear-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = { __webUiAccountsLive: {
    records: new Map([
      [GROK_REF, { provider: 'grok', accountRef: GROK_REF }],
      [CODEX_REF, { provider: 'codex', accountRef: CODEX_REF }]
    ]),
    watchers: new Set(), webSocketWatchers: new Set(),
    loadedFromDisk: false, revision: 0
  } };
  const ctx = { state, fs, aiHomeDir: root };
  updateCachedAccountTokenUsage(ctx, { [GROK_REF]: tokens(100), [CODEX_REF]: tokens(200) }, { generatedAt: 1 });
  updateCachedAccountTokenUsage(ctx, {}, { provider: 'grok', generatedAt: 2 });
  assert.equal(state.__webUiAccountsLive.records.get(GROK_REF).tokenUsage.total, 0);
  assert.equal(state.__webUiAccountsLive.records.get(CODEX_REF).tokenUsage.total, 200);
});

test('a provider refresh before the first full snapshot still accepts other accounts from the older full query', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-token-cache-initial-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = { __webUiAccountsLive: {
    records: new Map([
      [GROK_REF, { provider: 'grok', accountRef: GROK_REF }],
      [CODEX_REF, { provider: 'codex', accountRef: CODEX_REF }]
    ]),
    watchers: new Set(), webSocketWatchers: new Set(),
    loadedFromDisk: false, revision: 0
  } };
  const ctx = { state, fs, aiHomeDir: root };
  updateCachedAccountTokenUsage(ctx, { [GROK_REF]: tokens(17968) }, { provider: 'grok', generatedAt: 20 });
  updateCachedAccountTokenUsage(ctx, { [GROK_REF]: tokens(100), [CODEX_REF]: tokens(200) }, { generatedAt: 10 });
  assert.equal(state.__webUiAccountsLive.records.get(GROK_REF).tokenUsage.total, 17968);
  assert.equal(state.__webUiAccountsLive.records.get(CODEX_REF).tokenUsage.total, 200);
});
