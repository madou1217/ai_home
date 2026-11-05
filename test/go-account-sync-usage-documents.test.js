'use strict';

// 额度快照文档的单一真相在 Go：Node 的 app_kv 只是可重建的读缓存。
//   * 本地更新的文档必须推给 Go（WebUI 采集链仍在 Node）；
//   * 采集时间早于当前凭据的文档不得推回去（Go 在换凭据时已删除）；
//   * Go 更新的文档必须回填本地缓存（换机/清库后自愈）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readJsonValue, writeJsonValue } = require('../lib/server/app-state-store');
const { SYNC_STATE_KEY, createGoAccountSync, planFingerprint } = require('../lib/server/go-account-sync');
const { translateNodeAccount } = require('../lib/account/go-bridge/go-import-translator');

const GO_REF = 'acct_11111111111111111111';
const ACCOUNT_REF = 'acct_aaaaaaaaaaaaaaaaaaaa';
const USAGE_KEY = `account:usage:${ACCOUNT_REF}`;

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-gsync-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function codexRecord(overrides = {}) {
  return {
    accountRef: ACCOUNT_REF,
    provider: 'codex',
    cliAccountId: '1',
    createdAt: 1,
    updatedAt: 1,
    status: 'up',
    env: { OPENAI_API_KEY: 'sk-same-key', OPENAI_BASE_URL: 'https://api.example/v1' },
    nativeAuth: {},
    envUpdatedAt: 1000,
    nativeAuthUpdatedAt: 0,
    ...overrides
  };
}

function goCodexAccount() {
  return {
    accountRef: GO_REF,
    provider: 'codex',
    cliAccountId: 1,
    enabled: true,
    authKind: 'api_key',
    authMode: '',
    credential: { api_key: 'sk-same-key', base_url: 'https://api.example/v1' },
    credentialUpdatedAtMs: 1000,
    profile: {}
  };
}

function seed(t, record, goDocuments, goUsage = []) {
  const aiHomeDir = tmp(t);
  writeJsonValue(fs, aiHomeDir, SYNC_STATE_KEY, {
    links: {
      [record.accountRef]: {
        goRef: GO_REF,
        print: planFingerprint(translateNodeAccount(record))
      }
    },
    modelPolicies: [],
    rejectedImports: {}
  });
  const calls = [];
  const client = new Proxy({
    async send(request) {
      calls.push({ method: request.method, path: request.path, body: request.body });
      return { ok: true, status: 200, data: { account_ref: GO_REF } };
    },
    async putUsageDocument(accountRef, document) {
      calls.push({ method: 'PUT', path: `/v1/management/accounts/${accountRef}/usage-document`, body: document });
      return { ok: true, status: 200, data: null, errorCode: '' };
    },
    async listUsageDocuments() {
      return { ok: true, status: 200, data: goDocuments, errorCode: '' };
    },
    async listAccountUsage() {
      return { ok: true, status: 200, data: goUsage, errorCode: '' };
    }
  }, {
    get: (target, prop) => (prop in target ? target[prop] : async () => ({ ok: true, status: 200, data: null, errorCode: '' }))
  });
  const sync = createGoAccountSync({
    fs,
    aiHomeDir,
    log: { log() {}, warn() {}, error() {} },
    readNodeAccounts: () => ({ accounts: [record], defaults: {} }),
    readGoAccounts: () => ({ accounts: [goCodexAccount()], defaults: {} }),
    readModelCatalogSettings: () => ({}),
    getClient: () => client
  });
  return { sync, calls, aiHomeDir };
}

test('a newer local quota snapshot is pushed to Go', async (t) => {
  const record = codexRecord();
  const { sync, calls, aiHomeDir } = seed(t, record, []);
  const snapshot = { schemaVersion: 2, kind: 'codex_oauth_status', source: 'codex_read_rate_limits', capturedAt: 2000, entries: [] };
  writeJsonValue(fs, aiHomeDir, USAGE_KEY, snapshot);

  const result = await sync.reconcile();
  assert.equal(result.usageDocumentsPushed, 1);
  assert.equal(result.usageFactsPushed, 1);

  const facts = calls.filter((call) => call.path.endsWith('/usage'));
  assert.equal(facts.length, 1);
  assert.equal(facts[0].path, `/v1/management/accounts/${GO_REF}/usage`);
  assert.equal(facts[0].body.source, 'codex_read_rate_limits');
  assert.equal(facts[0].body.collected, true);
  assert.equal(facts[0].body.captured_at, '2000');
  assert.equal(facts[0].body.entries.length, 1, 'an empty snapshot still clears stale facts');
  assert.equal(facts[0].body.entries[0].availability, 'unknown');

  const pushed = calls.filter((call) => call.path.endsWith('/usage-document'));
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].path, `/v1/management/accounts/${GO_REF}/usage-document`);
  assert.equal(pushed[0].body.captured_at, '2000');
  assert.equal(pushed[0].body.kind, 'codex_oauth_status');
  assert.equal(pushed[0].body.source, 'codex_read_rate_limits');
  assert.deepEqual(pushed[0].body.payload, snapshot);
});

test('a snapshot captured before the current credential is never pushed back', async (t) => {
  const record = codexRecord({ envUpdatedAt: 5000 });
  const { sync, calls, aiHomeDir } = seed(t, record, []);
  writeJsonValue(fs, aiHomeDir, USAGE_KEY, { kind: 'codex_oauth_status', source: 'codex_read_rate_limits', capturedAt: 2000 });

  const result = await sync.reconcile();
  assert.equal(result.usageDocumentsPushed, 0);
  assert.equal(result.usageFactsPushed, 0);
  assert.equal(calls.filter((call) => call.path.endsWith('/usage-document')).length, 0);
  assert.equal(calls.filter((call) => call.path.endsWith('/usage')).length, 0);
});

test('a newer Go document repairs the local read cache', async (t) => {
  const record = codexRecord();
  const payload = { schemaVersion: 2, kind: 'codex_oauth_status', source: 'codex_read_rate_limits', capturedAt: 9000, entries: [{ bucket: 'primary', remainingPct: 71 }] };
  const { sync, calls, aiHomeDir } = seed(t, record, [{
    account_ref: GO_REF,
    provider_id: 'codex',
    kind: 'codex_oauth_status',
    source: 'codex_read_rate_limits',
    captured_at: new Date(9000).toISOString(),
    captured_at_ms: 9000,
    payload
  }]);

  const result = await sync.reconcile();
  assert.equal(result.usageDocumentsPulled, 1);
  assert.equal(result.usageDocumentsPushed, 0);
  assert.equal(result.usageFactsPushed, 0);
  assert.equal(calls.filter((call) => call.path.endsWith('/usage-document')).length, 0);
  assert.deepEqual(readJsonValue(fs, aiHomeDir, USAGE_KEY), payload);
});
