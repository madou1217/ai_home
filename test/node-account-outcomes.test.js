'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createNodeAccountOutcomes,
  localDayStart,
  localHourStart,
  normalizeOutcome
} = require('../lib/server/node-account-outcomes');

function createStore(options = {}) {
  const state = { saved: null, writes: 0 };
  const nowMs = options.nowMs || new Date(2026, 9, 14, 19, 30).getTime();
  const store = createNodeAccountOutcomes({
    fs: {},
    aiHomeDir: '/tmp/aih-node-outcomes-test',
    now: () => nowMs,
    readJsonValue: options.readJsonValue || (() => null),
    writeJsonValue: (_fs, _dir, _key, value) => {
      state.saved = value;
      state.writes += 1;
      return true;
    }
  });
  return { store, state, nowMs };
}

test('node account outcomes bucket successes and failures per local hour and day', () => {
  const { store, nowMs } = createStore();
  const at = new Date(2026, 9, 14, 19, 10).getTime();
  assert.equal(store.record({ accountRef: 'acct_1', outcome: 'success', atMs: at }), true);
  assert.equal(store.record({ accountRef: 'acct_1', outcome: 'success', atMs: at + 1000 }), true);
  assert.equal(store.record({ accountRef: 'acct_1', outcome: 'permission_denied', atMs: at + 2000 }), true);
  assert.equal(store.record({ accountRef: 'acct_1', outcome: 'permission_denied', atMs: at + 3000 }), true);
  assert.equal(store.record({ accountRef: '', outcome: 'success', atMs: at }), false, 'no account means no bucket');

  assert.deepEqual(store.list('hour', localHourStart(nowMs)).sort((a, b) => a.outcome.localeCompare(b.outcome)), [
    { account_ref: 'acct_1', bucket_start_ms: localHourStart(at), outcome: 'permission_denied', count: 2 },
    { account_ref: 'acct_1', bucket_start_ms: localHourStart(at), outcome: 'success', count: 2 }
  ]);
  assert.deepEqual(store.list('day', localDayStart(nowMs)).sort((a, b) => a.outcome.localeCompare(b.outcome)), [
    { account_ref: 'acct_1', bucket_start_ms: localDayStart(at), outcome: 'permission_denied', count: 2 },
    { account_ref: 'acct_1', bucket_start_ms: localDayStart(at), outcome: 'success', count: 2 }
  ]);
  assert.deepEqual(store.list('day', localDayStart(nowMs) + 1), [], 'fromMs filters older buckets');
});

test('node account outcomes survive a flush/reload round trip and prune the retention window', () => {
  const { store, state } = createStore();
  const today = new Date(2026, 9, 14, 12, 0).getTime();
  const stale = new Date(2026, 4, 1, 12, 0).getTime();
  store.record({ accountRef: 'acct_1', outcome: 'success', atMs: today });
  store.record({ accountRef: 'acct_1', outcome: 'quota_exhausted', atMs: today });
  store.record({ accountRef: 'acct_1', outcome: 'success', atMs: stale });
  assert.equal(store.flush(), true);
  assert.equal(state.writes, 1);

  const reloaded = createNodeAccountOutcomes({
    fs: {},
    aiHomeDir: '/tmp/aih-node-outcomes-test',
    now: () => new Date(2026, 9, 14, 19, 30).getTime(),
    readJsonValue: () => state.saved,
    writeJsonValue: () => true
  });
  assert.deepEqual(reloaded.list('day', 0).sort((a, b) => a.outcome.localeCompare(b.outcome)), [
    { account_ref: 'acct_1', bucket_start_ms: localDayStart(today), outcome: 'quota_exhausted', count: 1 },
    { account_ref: 'acct_1', bucket_start_ms: localDayStart(today), outcome: 'success', count: 1 }
  ], 'stale buckets beyond the 91-day retention are dropped on load');
});

test('node account outcome labels are normalized to the Go-style vocabulary', () => {
  assert.equal(normalizeOutcome('Success'), 'success');
  assert.equal(normalizeOutcome('http_503'), 'http_503');
  assert.equal(normalizeOutcome('HTTP 403'), 'http_403');
  assert.equal(normalizeOutcome(''), 'failed');
  assert.equal(normalizeOutcome(null), 'failed');
  const { store } = createStore();
  store.record({ accountRef: 'acct_1', outcome: 'Rate Limited', atMs: new Date(2026, 9, 14, 12, 0).getTime() });
  assert.deepEqual(store.list('hour', 0), [
    { account_ref: 'acct_1', bucket_start_ms: new Date(2026, 9, 14, 12, 0).getTime(), outcome: 'rate_limited', count: 1 }
  ]);
});
