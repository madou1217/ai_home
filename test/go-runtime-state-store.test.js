'use strict';

// 运行态文档的进程内 store 与 account_state_index 的读合并。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createGoRuntimeStateStore } = require('../lib/server/go-runtime-state-store');
const { createAccountStateIndex } = require('../lib/account/state-index');
const { registerAccountIdentity } = require('../lib/account/account-registration');

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-runtime-state-'));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_error) {}
  });
  return dir;
}

function createPushRecorder() {
  const pushes = [];
  return {
    pushes,
    put: async (ref, state, updatedAt) => {
      pushes.push({ kind: 'put', ref, state, updatedAt });
      return { ok: true };
    },
    remove: async (ref, updatedAt) => {
      pushes.push({ kind: 'remove', ref, updatedAt });
      return { ok: true };
    }
  };
}

test('store hydrates from Go, writes immediately and flushes to Go', async () => {
  const recorder = createPushRecorder();
  const reader = {
    list: () => [{
      accountRef: 'acct_aaaaaaaaaaaaaaaaaaaa',
      state: { authInvalidUntil: 5000 },
      updatedAt: 1000
    }]
  };
  const store = createGoRuntimeStateStore({
    reader,
    put: recorder.put,
    remove: recorder.remove
  });
  assert.equal(store.hydrate(), 1);
  assert.deepEqual(store.get('acct_aaaaaaaaaaaaaaaaaaaa').state, { authInvalidUntil: 5000 });

  store.set('acct_bbbbbbbbbbbbbbbbbbbb', { rateLimitUntil: 9000 }, 2000);
  // 写后立即可读，不等 HTTP 往返。
  assert.equal(store.get('acct_bbbbbbbbbbbbbbbbbbbb').state.rateLimitUntil, 9000);

  await store.flush();
  const puts = recorder.pushes.filter((entry) => entry.kind === 'put');
  assert.ok(puts.some((entry) => entry.ref === 'acct_bbbbbbbbbbbbbbbbbbbb'));
});

test('store retries failed pushes and clears with a tombstone', async () => {
  let failNext = true;
  const pushes = [];
  const store = createGoRuntimeStateStore({
    reader: { list: () => [] },
    put: async (ref, state) => {
      pushes.push(ref);
      if (failNext) return { ok: false };
      return { ok: true };
    },
    remove: async (ref) => {
      pushes.push(ref);
      return { ok: true };
    },
    retryMs: 0
  });
  store.set('acct_bbbbbbbbbbbbbbbbbbbb', { rateLimitUntil: 9000 }, 2000);
  const first = await store.flush();
  assert.equal(first.failed, 1);
  failNext = false;
  const second = await store.flush();
  assert.equal(second.pushed, 1);

  store.clear('acct_bbbbbbbbbbbbbbbbbbbb', 3000);
  assert.equal(store.get('acct_bbbbbbbbbbbbbbbbbbbb').state, null);
  await store.flush();
});

test('index reads the store and stops writing the legacy column', async (t) => {
  const aiHomeDir = tempHome(t);
  const store = createGoRuntimeStateStore({
    reader: { list: () => [] },
    put: async () => ({ ok: true }),
    remove: async () => ({ ok: true })
  });
  const account = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    identitySeed: 'demo:runtime-state'
  });
  const index = createAccountStateIndex({ fs, aiHomeDir, runtimeStates: store });
  t.after(() => index.close());

  const until = Date.now() + 60_000;
  assert.equal(index.upsertRuntimeState(account.accountRef, 'codex', {
    rateLimitUntil: until,
    lastFailureKind: 'rate_limited',
    lastFailureAt: Date.now()
  }, { status: 'up', configured: true }), true);

  const state = index.getAccountState(account.accountRef);
  assert.equal(state.runtimeState.rateLimitUntil, until);

  const raw = index.dbFile
    ? new (require('node:sqlite').DatabaseSync)(index.dbFile, { readOnly: true })
    : null;
  t.after(() => { try { raw && raw.close(); } catch (_error) {} });
  const row = raw.prepare('SELECT runtime_state FROM account_state WHERE account_ref = ?').get(account.accountRef);
  assert.equal(row.runtime_state, null, 'legacy column must not be written');

  index.clearRuntimeState(account.accountRef);
  assert.equal(index.getAccountState(account.accountRef).runtimeState, null);
});

test('index keeps writing the legacy column when no Go store is wired', async (t) => {
  const aiHomeDir = tempHome(t);
  const account = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    identitySeed: 'demo:runtime-state-legacy'
  });
  const index = createAccountStateIndex({ fs, aiHomeDir });
  t.after(() => index.close());
  index.upsertRuntimeState(account.accountRef, 'codex', { rateLimitUntil: 42_000 }, { status: 'up' });
  assert.equal(index.getAccountState(account.accountRef).runtimeState.rateLimitUntil, 42_000);
});
