'use strict';

// 启停对账不得依赖凭据推送成功（docs/plans/2026-11-06-account-enable-unification.md 2.2）。
//
// 旧实现把「本轮 pushAccount 成功」当作进入启停/default 对账的门槛：import 一直失败的
// 账号（例如 cline import 500）永远轮不到 enabled 收敛。这里锁住两条不变量：
//   1. push 失败但 link 仍在时，enabled 仍按 Node 的 status 收敛；
//   2. 多个 Node 账号映射同一 Go 身份时，仍以 source.accounts 里的首个账号为主，
//      不因推送失败改变主账号选择。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readJsonValue, writeJsonValue } = require('../lib/server/app-state-store');
const { SYNC_STATE_KEY, createGoAccountSync } = require('../lib/server/go-account-sync');

const GO_REF = 'acct_44444444444444444444';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-gsync-enable-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function codexRecord(accountRef, status, apiKey) {
  return {
    accountRef,
    provider: 'codex',
    cliAccountId: accountRef,
    createdAt: 1,
    updatedAt: 1,
    status,
    env: { OPENAI_API_KEY: apiKey, OPENAI_BASE_URL: '' },
    nativeAuth: {},
    envUpdatedAt: 1,
    nativeAuthUpdatedAt: 0
  };
}

function goCodexAccount({ accountRef = GO_REF, apiKey = 'sk-first', enabled = true } = {}) {
  return {
    accountRef,
    provider: 'codex',
    cliAccountId: 1,
    enabled,
    authKind: 'api_key',
    authMode: '',
    credential: { api_key: apiKey, base_url: '' },
    credentialUpdatedAtMs: 1,
    profile: {}
  };
}

function stateWithLinks(links) {
  return {
    links,
    modelPolicies: [],
    rejectedImports: {}
  };
}

// 所有凭据写入都 500；只有启停写入被记录并成功，用来观察对账是否仍然发生。
function pushFailingClient(calls) {
  return new Proxy({
    async send(request) {
      calls.push({ method: request.method, path: request.path });
      return { ok: false, status: 500, errorCode: 'internal_error' };
    },
    async setEnabled(accountRef, enabled) {
      calls.push({ method: 'SET_ENABLED', accountRef, enabled });
      return { ok: true, status: 200, data: null, errorCode: '' };
    }
  }, {
    get: (target, prop) => (prop in target ? target[prop] : async () => ({ ok: true, status: 200, data: null, errorCode: '' }))
  });
}

function makeSync({ aiHomeDir, accounts, goAccounts, client }) {
  return createGoAccountSync({
    fs,
    aiHomeDir,
    log: { log() {}, warn() {}, error() {} },
    readNodeAccounts: () => ({ accounts, defaults: {} }),
    readGoAccounts: () => ({ accounts: goAccounts, defaults: {}, modelPolicies: [] }),
    readModelCatalogSettings: () => ({}),
    getClient: () => client
  });
}

test('a failed credential push does not skip enabled reconciliation for a linked account', async (t) => {
  const aiHomeDir = tmp(t);
  const record = codexRecord('acct_aaaaaaaaaaaaaaaaaaaa', 'up', 'sk-first');
  // print 与当前内容不同：本轮一定会尝试推送凭据。
  writeJsonValue(fs, aiHomeDir, SYNC_STATE_KEY, stateWithLinks({
    [record.accountRef]: { goRef: GO_REF, print: 'outdated-print' }
  }));

  const calls = [];
  const sync = makeSync({
    aiHomeDir,
    accounts: [record],
    goAccounts: [goCodexAccount({ enabled: false })],
    client: pushFailingClient(calls)
  });

  const result = await sync.reconcile();

  const pushErrors = result.errors.filter((error) => error.step === 'push');
  assert.equal(result.pushed, 0, 'credential push must have failed');
  assert.equal(pushErrors.length, 1);
  assert.equal(pushErrors[0].error, 'internal_error');
  assert.equal(result.enabledChanged, 1, 'enabled must still converge despite the push failure');
  assert.deepEqual(
    calls.filter((call) => call.method === 'SET_ENABLED'),
    [{ method: 'SET_ENABLED', accountRef: GO_REF, enabled: true }]
  );

  const state = readJsonValue(fs, aiHomeDir, SYNC_STATE_KEY);
  assert.equal(state.links[record.accountRef].goRef, GO_REF);
  assert.equal(state.links[record.accountRef].print, 'outdated-print', 'a failed push must not rewrite the link');
  sync.stop && sync.stop();
});

test('the first Node account still wins for a shared Go identity when every push fails', async (t) => {
  const aiHomeDir = tmp(t);
  const disabled = codexRecord('acct_bbbbbbbbbbbbbbbbbbbb', 'down', 'sk-first');
  const enabled = codexRecord('acct_cccccccccccccccccccc', 'up', 'sk-second');
  writeJsonValue(fs, aiHomeDir, SYNC_STATE_KEY, stateWithLinks({
    [disabled.accountRef]: { goRef: GO_REF, print: 'outdated-first' },
    [enabled.accountRef]: { goRef: GO_REF, print: 'outdated-second' }
  }));

  const calls = [];
  const sync = makeSync({
    aiHomeDir,
    accounts: [disabled, enabled],
    goAccounts: [goCodexAccount({ enabled: true })],
    client: pushFailingClient(calls)
  });

  const result = await sync.reconcile();

  assert.equal(result.pushed, 0, 'credential pushes must have failed');
  assert.equal(result.errors.filter((error) => error.step === 'push').length, 2);
  assert.deepEqual(
    calls.filter((call) => call.method === 'SET_ENABLED'),
    [{ method: 'SET_ENABLED', accountRef: GO_REF, enabled: false }],
    'only the first Node account may decide enabled, even without any push success'
  );
  assert.equal(result.enabledChanged, 1);
  sync.stop && sync.stop();
});
