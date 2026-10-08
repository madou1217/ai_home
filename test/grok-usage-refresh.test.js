'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createGrokUsageRefresh } = require('../lib/usage/grok-usage-refresh');
const { createModelUsageService } = require('../lib/usage/model-usage-service');

const SESSION_ID = '01a110db-d8fb-7991-a70f-9894655f7238';
const ACCOUNT_REF = 'acct_1234567890abcdef1234';

function createHarness(t, overrides = {}) {
  const bus = new EventEmitter();
  const timers = new Set();
  const updates = [];
  const cacheOptions = [];
  const scans = [];
  const warnings = [];
  const service = {
    scanGrokSessionUsage(id) { scans.push(id); return { records: 1 }; },
    getAccountTokenUsageAsync: async () => ({ [ACCOUNT_REF]: { total: 17968 } }),
    ...overrides.service
  };
  const refresh = createGrokUsageRefresh({
    sessionEventBus: bus,
    modelUsageService: service,
    setTimeoutFn(fn, ms) {
      const timer = { fn, ms, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => timers.delete(timer),
    onTokenUsageUpdated: (usage, options) => { updates.push(usage); cacheOptions.push(options); },
    logWarn: (message) => warnings.push(message),
    ...overrides.options
  });
  refresh.start();
  t.after(() => refresh.stop());
  return {
    bus, refresh, service, scans, timers, updates, cacheOptions, warnings,
    complete(event = {}) {
      bus.emit('session', { provider: 'grok', sessionId: SESSION_ID, type: 'session:turn-completed', ...event });
    },
    async tick() {
      const timer = timers.values().next().value;
      assert.ok(timer, 'a refresh timer must be pending');
      timers.delete(timer);
      await timer.fn();
      return timer.ms;
    }
  };
}

test('Grok completed turns refresh the account token cache and coalesce duplicate hooks', async (t) => {
  const h = createHarness(t);
  h.refresh.start();
  h.complete();
  h.complete({ type: 'session:closed' });
  assert.equal(h.timers.size, 1);
  assert.deepEqual(h.scans, []);
  assert.equal(await h.tick(), 250);
  assert.deepEqual(h.scans, [SESSION_ID]);
  assert.equal(h.updates[0][ACCOUNT_REF].total, 17968);
  assert.equal(h.timers.size, 0);
});

test('Grok usage refresh ignores nonterminal events, other providers and unsafe session identities', (t) => {
  const h = createHarness(t);
  h.complete({ type: 'session:turn-started' });
  h.complete({ provider: 'codex' });
  h.complete({ sessionId: '../outside' });
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.scans, []);
});

test('Grok usage refresh consumes a real JSONL bill written after Stop and after a partial line', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-grok-live-usage-'));
  const aiHomeDir = path.join(root, '.ai_home');
  const sessionDir = path.join(root, '.grok', 'sessions', '%2Fworkspace', SESSION_ID);
  const service = createModelUsageService({ fs, path, hostHomeDir: root, aiHomeDir, enableAsyncQueries: false });
  t.after(() => { service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const h = createHarness(t, { service: {
    scanGrokSessionUsage: service.scanGrokSessionUsage,
    getAccountTokenUsageAsync: service.getAccountTokenUsageAsync
  } });
  h.complete();
  assert.equal(await h.tick(), 250);
  assert.equal(h.updates.length, 0);

  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'summary.json'), JSON.stringify({
    grok_home: path.join(aiHomeDir, 'run', 'auth-projections', 'grok', ACCOUNT_REF, '.grok'),
    info: { cwd: '/workspace' }
  }));
  const bill = JSON.stringify({ params: {
    _meta: { agentTimestampMs: Date.now() - 100, totalTokens: 999999 },
    update: { sessionUpdate: 'turn_completed', prompt_id: 'prompt-1', usage: {
      modelUsage: { 'grok-4.7': {
        inputTokens: 17898, outputTokens: 70, cachedReadTokens: 1664,
        reasoningTokens: 41, costUsdTicks: 337200000
      } }
    } }
  } });
  const file = path.join(sessionDir, 'updates.jsonl');
  fs.writeFileSync(file, bill.slice(0, 80));
  assert.equal(await h.tick(), 1000);
  assert.equal(h.updates.length, 0);
  fs.appendFileSync(file, `${bill.slice(80)}\n`);
  assert.equal(await h.tick(), 3000);
  const usage = h.updates[0][ACCOUNT_REF];
  assert.equal(usage.total, 17968);
  assert.equal(usage.models[0].model, 'grok-4.7');
  assert.equal(service.getStats({ provider: 'grok' }).totalTokens, 17968);

  h.complete();
  for (let attempt = 0; attempt < 3; attempt += 1) await h.tick();
  assert.equal(h.updates[1][ACCOUNT_REF].total, 17968);
  assert.equal(h.timers.size, 0);
});

test('Grok failed or empty turns stop retrying after three reads and still refresh stale caches', async (t) => {
  const h = createHarness(t, { service: { scanGrokSessionUsage() { return { records: 0 }; } } });
  h.complete({ type: 'session:turn-failed' });
  assert.deepEqual([await h.tick(), await h.tick(), await h.tick()], [250, 1000, 3000]);
  assert.equal(h.timers.size, 0);
  assert.equal(h.updates.length, 1);
});

test('Grok usage refresh retries cache failures without needing another bill insertion', async (t) => {
  let scans = 0;
  let queries = 0;
  const h = createHarness(t, { service: {
    scanGrokSessionUsage: () => ({ records: scans++ === 0 ? 1 : 0 }),
    getAccountTokenUsageAsync: async () => {
      if (queries++ === 0) throw new Error('query_temporarily_unavailable');
      return { [ACCOUNT_REF]: { total: 17968 } };
    }
  } });
  h.complete();
  await h.tick();
  assert.equal(h.warnings.length, 1);
  await h.tick();
  assert.equal(h.updates.length, 1);
  assert.equal(h.timers.size, 0);
});

test('Grok usage refresh serializes events received during a cache query', async (t) => {
  let release;
  let queryCount = 0;
  const h = createHarness(t, { service: {
    getAccountTokenUsageAsync: () => ++queryCount === 1
      ? new Promise((resolve) => { release = resolve; })
      : Promise.resolve({})
  } });
  h.complete();
  const first = h.tick();
  await new Promise((resolve) => setImmediate(resolve));
  h.complete();
  assert.equal(h.timers.size, 0);
  release({});
  await first;
  assert.equal(h.timers.size, 1);
  await h.tick();
  assert.deepEqual(h.scans, [SESSION_ID, SESSION_ID]);
  assert.equal(h.timers.size, 0);
});

test('a new Grok completion during a cache query still waits for its delayed bill', async (t) => {
  let release;
  let queryCount = 0;
  let scanCount = 0;
  const h = createHarness(t, { service: {
    scanGrokSessionUsage: () => ({ records: ++scanCount === 2 ? 0 : 1 }),
    getAccountTokenUsageAsync: () => ++queryCount === 1
      ? new Promise((resolve) => { release = resolve; })
      : Promise.resolve({ [ACCOUNT_REF]: { total: 35936 } })
  } });
  h.complete();
  const first = h.tick();
  await new Promise((resolve) => setImmediate(resolve));
  h.complete();
  release({ [ACCOUNT_REF]: { total: 17968 } });
  await first;

  assert.equal(await h.tick(), 250);
  assert.equal(h.updates.length, 1, 'the previous bill must not end retries for the new turn');
  assert.equal(await h.tick(), 1000);
  assert.equal(h.updates[1][ACCOUNT_REF].total, 35936);
  assert.equal(h.timers.size, 0);
});

test('Grok usage refresh respects disabled scans and removes pending work on shutdown', async (t) => {
  const disabled = createHarness(t, { options: { enabled: false } });
  disabled.complete();
  assert.equal(disabled.timers.size, 0);
  const h = createHarness(t);
  h.complete();
  h.refresh.stop();
  assert.equal(h.timers.size, 0);
  assert.equal(h.bus.listenerCount('session'), 0);
  h.complete();
  assert.deepEqual(h.scans, []);
});

test('Grok usage refresh does not publish a query result after shutdown', async (t) => {
  let release;
  const h = createHarness(t, { service: {
    getAccountTokenUsageAsync: () => new Promise((resolve) => { release = resolve; })
  } });
  h.complete();
  const first = h.tick();
  await new Promise((resolve) => setImmediate(resolve));
  h.refresh.stop();
  release({});
  await first;
  assert.equal(h.updates.length, 0);
  assert.equal(h.timers.size, 0);
});

test('Grok usage cache cutoff matches the query window so newer gateway deltas stay pending', async (t) => {
  let queryOptions;
  const h = createHarness(t, { service: {
    getAccountTokenUsageAsync: async (options) => { queryOptions = options; return {}; }
  } });
  h.complete();
  await h.tick();
  assert.ok(queryOptions.nowMs > 0);
  assert.equal(queryOptions.provider, 'grok');
  assert.equal(h.cacheOptions[0].provider, 'grok');
  assert.equal(h.cacheOptions[0].generatedAt, queryOptions.nowMs);
});
