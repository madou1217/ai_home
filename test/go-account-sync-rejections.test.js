'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createGoAccountSync, SYNC_STATE_KEY } = require('../lib/server/go-account-sync');
const { readJsonValue, writeJsonValue } = require('../lib/server/app-state-store');

const NODE_REF = 'acct_00000000000000000001';
const GO_REF = 'acct_00000000000000000002';

function fixture(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-go-sync-rejections-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const record = {
    provider: 'opencode', accountRef: NODE_REF, cliAccountId: '1', status: 'up', env: {},
    nativeAuth: { auth: { openai: { type: 'api', key: 'synthetic-opencode-key ' } } }
  };
  const node = { accounts: [record], defaults: {} };
  const go = { accounts: [], defaults: {}, modelPolicies: [] };
  const requests = [];
  let response = { ok: false, status: 422, errorCode: 'invalid_native_artifacts' };
  const client = {
    async send(request) {
      requests.push(request);
      if (response.ok) go.accounts = [{ provider: 'opencode', accountRef: GO_REF, enabled: true }];
      return response;
    }
  };
  const buildSync = () => createGoAccountSync({
    fs, aiHomeDir, getClient: () => client,
    readNodeAccounts: () => node, readGoAccounts: () => go, readModelCatalogSettings: () => ({}),
    log: { error() {} }
  });
  return {
    record, node, go, requests, buildSync,
    respond: (next) => { response = next; },
    state: () => readJsonValue(fs, aiHomeDir, SYNC_STATE_KEY),
    seedState: (value) => writeJsonValue(fs, aiHomeDir, SYNC_STATE_KEY, value)
  };
}

test('permanently rejected content is quiet across restarts and retries when credentials change', async (t) => {
  const f = fixture(t);
  let sync = f.buildSync();
  const first = await sync.reconcile();
  assert.equal(first.pushed, 0);
  assert.equal(first.errors[0].error, 'invalid_native_artifacts');
  assert.equal(f.requests.length, 1);

  const repeated = await sync.reconcile();
  assert.equal(repeated.errors[0].error, 'invalid_native_artifacts', 'cached rejection remains observable');
  assert.equal(f.requests.length, 1, 'unchanged invalid content is not sent again');
  const persisted = f.state().rejectedImports[NODE_REF];
  assert.deepEqual(Object.keys(persisted).sort(), ['error', 'print']);
  assert.match(persisted.print, /^[a-f0-9]{64}$/);
  assert.equal(persisted.error, 'invalid_native_artifacts');
  assert.equal(JSON.stringify(f.state()).includes('synthetic-opencode-key'), false, 'state contains no credential');

  await sync.stop();
  sync = f.buildSync();
  assert.equal((await sync.reconcile()).errors[0].error, 'invalid_native_artifacts');
  assert.equal(f.requests.length, 1, 'rebuilding the synchronizer keeps the rejection');

  f.record.nativeAuth.auth.openai.key = 'synthetic-opencode-key-corrected';
  f.respond({ ok: true, status: 201, data: { account_ref: GO_REF } });
  const changed = await sync.reconcile();
  assert.equal(changed.pushed, 1);
  assert.deepEqual(changed.errors, []);
  assert.equal(f.requests.length, 2, 'content change retries immediately');
  assert.deepEqual(f.state().rejectedImports, {});
  assert.equal(f.state().links[NODE_REF].goRef, GO_REF);
  assert.equal((await sync.reconcile()).pushed, 0);
  assert.equal(f.requests.length, 2, 'recovered content is quiet at steady state');
});

test('temporary or unrelated import failures retry unchanged content', async (t) => {
  for (const response of [
    { ok: false, status: 0, errorCode: 'network_error' },
    { ok: false, status: 0, errorCode: 'timeout' },
    { ok: false, status: 503, errorCode: 'invalid_native_artifacts' },
    { ok: false, status: 401, errorCode: 'unauthorized_management' },
    { ok: false, status: 422, errorCode: 'unsupported_provider' }
  ]) {
    await t.test(`${response.status} ${response.errorCode}`, async (t) => {
      const f = fixture(t);
      f.respond(response);
      const sync = f.buildSync();
      await sync.reconcile();
      await sync.reconcile();
      assert.equal(f.requests.length, 2);
      assert.deepEqual(f.state().rejectedImports, {});
    });
  }
});

test('rejections are pruned when the source disappears or is no longer importable', async (t) => {
  for (const change of ['removed', 'unsupported']) {
    await t.test(change, async (t) => {
      const f = fixture(t);
      const sync = f.buildSync();
      await sync.reconcile();
      if (change === 'removed') f.node.accounts = [];
      else f.record.nativeAuth = {};
      const result = await sync.reconcile();
      assert.deepEqual(result.errors, []);
      assert.deepEqual(f.state().rejectedImports, {});
      assert.equal(f.requests.length, 1);
    });
  }
});

test('older sync state without rejection records remains usable', async (t) => {
  const f = fixture(t);
  f.node.accounts = [];
  f.seedState({ links: {}, modelPolicies: [] });
  const result = await f.buildSync().reconcile();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(f.state(), { links: {}, modelPolicies: [], rejectedImports: {} });
});
