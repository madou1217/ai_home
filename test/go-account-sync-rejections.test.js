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

test('generation-arbitration refusals settle until content changes or the Go account disappears', async (t) => {
  const f = fixture(t);

  // 先成功导入，建立 link（模拟账号已在 Go 侧，随后 Node 侧内容被重写为解码态）。
  f.respond({ ok: true, status: 201, data: { account_ref: GO_REF } });
  let sync = f.buildSync();
  assert.equal((await sync.reconcile()).pushed, 1);
  assert.equal(f.requests.length, 1);

  // Node 内容变化（真实故障里只是昵称编码差异），Go 判定无法证明代际更新 → 409。
  f.record.nativeAuth.auth.openai.key = 'synthetic-opencode-key-reencoded';
  f.respond({ ok: false, status: 409, errorCode: 'account_import_generation_unordered' });
  const refused = await sync.reconcile();
  assert.equal(refused.pushed, 0);
  assert.equal(refused.errors[0].error, 'account_import_generation_unordered');
  assert.equal(refused.errors[0].cached, undefined, 'first refusal is reported without cache flag');
  assert.equal(f.requests.length, 2);
  const persisted = f.state().rejectedImports[NODE_REF];
  assert.deepEqual(Object.keys(persisted).sort(), ['error', 'goRef', 'print']);
  assert.equal(persisted.error, 'account_import_generation_unordered');
  assert.equal(persisted.goRef, GO_REF);
  assert.equal(JSON.stringify(f.state()).includes('synthetic-opencode-key'), false, 'state contains no credential');

  // 稳态：同一份内容不再发请求，但拒绝仍可观察。
  const repeated = await sync.reconcile();
  assert.equal(repeated.errors[0].error, 'account_import_generation_unordered');
  assert.equal(repeated.errors[0].cached, true);
  assert.equal(f.requests.length, 2, 'unchanged refused content is not sent again');

  // 重建同步器（进程重启）后仍然不再重发。
  await sync.stop();
  sync = f.buildSync();
  assert.equal((await sync.reconcile()).errors[0].cached, true);
  assert.equal(f.requests.length, 2, 'restart keeps the settled refusal');

  // 内容再次变化 → 缓存让路，立刻重试（凭据代际推进后即可被接受）。
  f.record.nativeAuth.auth.openai.key = 'synthetic-opencode-key-next-generation';
  const retried = await sync.reconcile();
  assert.equal(retried.errors[0].cached, undefined);
  assert.equal(f.requests.length, 3, 'content change re-arms the push');

  // Go 账号被删除 → 缓存必须让路，重新导入以重建账号。
  f.go.accounts = [];
  f.respond({ ok: true, status: 201, data: { account_ref: GO_REF } });
  const rebuilt = await sync.reconcile();
  assert.equal(rebuilt.pushed, 1);
  assert.deepEqual(rebuilt.errors, []);
  assert.equal(f.requests.length, 4, 'missing Go account re-arms the push');
  assert.deepEqual(f.state().rejectedImports, {});
  assert.equal(f.state().links[NODE_REF].goRef, GO_REF);
});
