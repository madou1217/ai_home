'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJsonValue, writeJsonValue } = require('../lib/server/app-state-store');
const { NATIVE_VALIDATOR_VERSION, SYNC_STATE_KEY, createGoAccountSync, planFingerprint } = require('../lib/server/go-account-sync');
const { translateNodeAccount } = require('../lib/account/go-bridge/go-import-translator');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-gsync-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const record = {
  accountRef: 'acct_kiro0000000000000001', provider: 'kiro', cliAccountId: '1', createdAt: 1, updatedAt: 1, status: 'up',
  env: {},
  nativeAuth: { auth: { access_token: 'a', refresh_token: 'r', region: 'us-east-1' }, identityEvidence: { subject: 's' } }
};

function makeSync(aiHomeDir, pushes) {
  return createGoAccountSync({
    fs, aiHomeDir,
    log: { log() {}, warn() {}, error() {} },
    readNodeAccounts: () => ({ accounts: [record], defaults: {} }),
    readGoAccounts: () => ({ accounts: [], defaults: {} }),
    readModelCatalogSettings: () => ({}),
    getClient: () => new Proxy({
      async send(request) {
        pushes.push(request.path);
        return { status: 422, errorCode: 'invalid_native_artifacts' };
      }
    }, {
      // 本用例只关心推送；其余调用（启停、默认值、模型策略）一律成功的空响应。
      get: (target, prop) => (prop in target ? target[prop] : async () => ({ status: 200, ok: true }))
    })
  });
}

test('a cached invalid_native_artifacts from an older validator is retried once', async (t) => {
  const aiHomeDir = tmp(t);
  const print = planFingerprint(translateNodeAccount(record));
  // 旧版本（无 validatorVersion）留下的终态拒绝。
  writeJsonValue(fs, aiHomeDir, SYNC_STATE_KEY, {
    links: {}, modelPolicies: [],
    rejectedImports: { [record.accountRef]: { print, error: 'invalid_native_artifacts' } }
  });
  const pushes = [];
  const sync = makeSync(aiHomeDir, pushes);
  const first = await sync.reconcile();
  assert.equal(pushes.length, 1, 'stale rejection must not block a retry after the validator changed');
  assert.ok(first.errors.some((e) => e.step === 'push' && !e.cached));
  assert.equal(readJsonValue(fs, aiHomeDir, SYNC_STATE_KEY).validatorVersion, NATIVE_VALIDATOR_VERSION);

  // 同一校验器版本下再次被拒：照旧走缓存，不会每轮重推。
  const second = await sync.reconcile();
  assert.equal(pushes.length, 1);
  assert.ok(second.errors.some((e) => e.cached));
  sync.stop && sync.stop();
});
