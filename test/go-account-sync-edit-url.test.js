'use strict';

// 编辑账号 URL 不得派生出新账号。
//
// Go 的静态账号身份 = 密钥 + base_url，所以用创建接口推送「改了 URL 的已存在账号」
// 会得到一个新 accountRef；旧 Go 账号随后被当成 Go 独有账号收养回 Node，账号页
// 就多出一条。这里锁住两条不变量：
//   1. 已链接的静态账号改 URL 走原地轮换（PUT .../credential），link 不变；
//   2. 同一把静态密钥的旧 Go 投影不得被收养成新 Node 账号。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readJsonValue, writeJsonValue } = require('../lib/server/app-state-store');
const { SYNC_STATE_KEY, createGoAccountSync, planFingerprint } = require('../lib/server/go-account-sync');
const { translateNodeAccount } = require('../lib/account/go-bridge/go-import-translator');

const GO_OLD_REF = 'acct_11111111111111111111';
const GO_NEW_REF = 'acct_22222222222222222222';
const GO_STALE_REF = 'acct_33333333333333333333';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-gsync-edit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function codexRecord(baseUrl) {
  return {
    accountRef: 'acct_aaaaaaaaaaaaaaaaaaaa',
    provider: 'codex',
    cliAccountId: '1',
    createdAt: 1,
    updatedAt: 1,
    status: 'up',
    env: { OPENAI_API_KEY: 'sk-same-key', OPENAI_BASE_URL: baseUrl },
    nativeAuth: {},
    envUpdatedAt: 1,
    nativeAuthUpdatedAt: 0
  };
}

function goCodexAccount(accountRef, baseUrl) {
  return {
    accountRef,
    provider: 'codex',
    cliAccountId: 1,
    enabled: true,
    authKind: 'api_key',
    authMode: '',
    credential: { api_key: 'sk-same-key', base_url: baseUrl },
    credentialUpdatedAtMs: 1,
    profile: {}
  };
}

function stateWithLink(record, goRef, print) {
  return {
    links: { [record.accountRef]: { goRef, print } },
    modelPolicies: [],
    rejectedImports: {}
  };
}

function recordingClient(calls) {
  return new Proxy({
    async send(request) {
      calls.push({ method: request.method, path: request.path, body: request.body });
      return { ok: true, status: 200, data: { account_ref: GO_OLD_REF } };
    },
    async deleteAccount(accountRef) {
      calls.push({ method: 'DELETE', path: `/v1/management/accounts/${accountRef}` });
      return { ok: true, status: 204, errorCode: '' };
    }
  }, {
    get: (target, prop) => (prop in target ? target[prop] : async () => ({ ok: true, status: 200, data: null, errorCode: '' }))
  });
}

test('editing a linked codex base URL rotates the Go credential in place', async (t) => {
  const aiHomeDir = tmp(t);
  const before = codexRecord('https://old.example/v1');
  const after = codexRecord('https://new.example/v1');
  writeJsonValue(fs, aiHomeDir, SYNC_STATE_KEY, stateWithLink(before, GO_OLD_REF, 'outdated-print'));

  const calls = [];
  const sync = createGoAccountSync({
    fs,
    aiHomeDir,
    log: { log() {}, warn() {}, error() {} },
    readNodeAccounts: () => ({ accounts: [after], defaults: {} }),
    readGoAccounts: () => ({ accounts: [goCodexAccount(GO_OLD_REF, 'https://old.example/v1')], defaults: {} }),
    readModelCatalogSettings: () => ({}),
    getClient: () => recordingClient(calls)
  });

  const result = await sync.reconcile();
  // 路由排除是派生投影（每轮询首圈强制对齐一次），不属于「账号写入」，这里只数账号写入。
  const pushed = calls.filter((call) => call.path.startsWith('/v1/management/accounts')
    && !call.path.endsWith('/routing'));
  assert.equal(pushed.length, 1, 'only one write may reach Go');
  assert.equal(pushed[0].method, 'PUT');
  assert.equal(pushed[0].path, `/v1/management/accounts/${GO_OLD_REF}/credential`);
  assert.equal(pushed[0].body.auth.base_url, 'https://new.example/v1');

  const state = readJsonValue(fs, aiHomeDir, SYNC_STATE_KEY);
  assert.equal(state.links[after.accountRef].goRef, GO_OLD_REF, 'Go accountRef must not change');
  assert.equal(state.links[after.accountRef].print, planFingerprint(translateNodeAccount(after)));
  sync.stop && sync.stop();
});

test('a stale Go projection with the same static key is never adopted as a new account', async (t) => {
  const aiHomeDir = tmp(t);
  const record = codexRecord('https://new.example/v1');
  writeJsonValue(
    fs,
    aiHomeDir,
    SYNC_STATE_KEY,
    stateWithLink(record, GO_NEW_REF, planFingerprint(translateNodeAccount(record)))
  );

  const calls = [];
  const sync = createGoAccountSync({
    fs,
    aiHomeDir,
    log: { log() {}, warn() {}, error() {} },
    readNodeAccounts: () => ({ accounts: [record], defaults: {} }),
    readGoAccounts: () => ({
      accounts: [
        goCodexAccount(GO_NEW_REF, 'https://new.example/v1'),
        goCodexAccount(GO_STALE_REF, 'https://old.example/v1')
      ],
      defaults: {}
    }),
    readModelCatalogSettings: () => ({}),
    getClient: () => recordingClient(calls)
  });

  const result = await sync.reconcile();
  assert.equal(result.adopted, 0, 'editing must not derive a new Node account');
  assert.equal(result.skippedStaticDuplicates, 1);
  assert.equal(calls.filter((call) => call.path.startsWith('/v1/management/accounts')
    && !call.path.endsWith('/routing')).length, 0);
  sync.stop && sync.stop();
});

test('when a link moves to a new Go account the old one is deleted, not adopted', async (t) => {
  const aiHomeDir = tmp(t);
  const record = {
    accountRef: 'acct_bbbbbbbbbbbbbbbbbbbb',
    provider: 'kiro',
    cliAccountId: '2',
    createdAt: 1,
    updatedAt: 1,
    status: 'up',
    env: {},
    nativeAuth: { auth: { access_token: 'a2', refresh_token: 'r2', region: 'us-east-1' }, identityEvidence: { subject: 's2' } }
  };
  writeJsonValue(fs, aiHomeDir, SYNC_STATE_KEY, stateWithLink(record, GO_OLD_REF, 'outdated-print'));

  const got = [];
  const calls = [];
  const client = new Proxy({
    async send(request) {
      calls.push({ method: request.method, path: request.path });
      got.push({
        accountRef: GO_NEW_REF,
        provider: 'kiro',
        cliAccountId: 2,
        enabled: true,
        authKind: 'oauth',
        authMode: '',
        credential: { access_token: 'a2', refresh_token: 'r2' },
        credentialUpdatedAtMs: 2,
        profile: {}
      });
      return { ok: true, status: 200, data: { account_ref: GO_NEW_REF } };
    },
    async deleteAccount(accountRef) {
      calls.push({ method: 'DELETE', path: `/v1/management/accounts/${accountRef}` });
      const index = got.findIndex((account) => account.accountRef === accountRef);
      if (index >= 0) got.splice(index, 1);
      return { ok: true, status: 204, errorCode: '' };
    }
  }, {
    get: (target, prop) => (prop in target ? target[prop] : async () => ({ ok: true, status: 200, data: null, errorCode: '' }))
  });

  const sync = createGoAccountSync({
    fs,
    aiHomeDir,
    log: { log() {}, warn() {}, error() {} },
    readNodeAccounts: () => ({ accounts: [record], defaults: {} }),
    readGoAccounts: () => ({
      accounts: got.length ? got : [{
        accountRef: GO_OLD_REF,
        provider: 'kiro',
        cliAccountId: 1,
        enabled: true,
        authKind: 'oauth',
        authMode: '',
        credential: { access_token: 'a1', refresh_token: 'r1' },
        credentialUpdatedAtMs: 1,
        profile: {}
      }],
      defaults: {}
    }),
    readModelCatalogSettings: () => ({}),
    getClient: () => client
  });

  const result = await sync.reconcile();
  assert.ok(calls.some((call) => call.method === 'DELETE' && call.path.endsWith(GO_OLD_REF)), 'old Go account must be deleted');
  assert.equal(result.adopted, 0, 'old Go account must not come back as a Node account');
  sync.stop && sync.stop();
});
