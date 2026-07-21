'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  deleteAccountCredentials,
  ensureCredentialTable,
  listAccountCredentialRecords,
  readAccountCredentialRecord,
  writeAccountCredentials,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const {
  listCliAccountCredentialRecords
} = require('../lib/cli/services/account/credential-records');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { openAppStateDatabase } = require('../lib/server/app-state-store');

function createStoreFixture(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-credential-store-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  return { aiHomeDir };
}

function registerAccount(aiHomeDir, provider, cliAccountId) {
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider,
    cliAccountId,
    identitySeed: `oauth:${provider}:account-${cliAccountId}@example.com`
  });
  assert.equal(typeof accountRef, 'string');
  assert.notEqual(accountRef, '');
  return accountRef;
}

test('account credential store keeps env and native auth in independent columns', (t) => {
  const { aiHomeDir } = createStoreFixture(t);
  const accountRef = registerAccount(aiHomeDir, 'gemini', '1');

  writeAccountCredentials(fs, aiHomeDir, accountRef, { GEMINI_API_KEY: 'key-1' });
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
    oauthCreds: { access_token: 'oauth-1' }
  });

  const record = readAccountCredentialRecord(fs, aiHomeDir, accountRef);
  assert.equal(record.provider, 'gemini');
  assert.equal(record.accountRef, accountRef);
  assert.equal(Object.hasOwn(record, 'cliAccountId'), false);
  assert.deepEqual(record.env, { GEMINI_API_KEY: 'key-1' });
  assert.deepEqual(record.nativeAuth, { oauthCreds: { access_token: 'oauth-1' } });
  assert.equal(Number.isInteger(record.envUpdatedAt) && record.envUpdatedAt > 0, true);
  assert.equal(Number.isInteger(record.nativeAuthUpdatedAt) && record.nativeAuthUpdatedAt > 0, true);
  assert.equal(Number.isInteger(record.updatedAt) && record.updatedAt > 0, true);
});

test('credential record listing and deletion use accountRef without profile directories', (t) => {
  const { aiHomeDir } = createStoreFixture(t);
  const account10Ref = registerAccount(aiHomeDir, 'opencode', '10');
  const account2Ref = registerAccount(aiHomeDir, 'opencode', '2');
  writeAccountNativeAuth(fs, aiHomeDir, account10Ref, { auth: { openai: { type: 'api', key: 'a' } } });
  writeAccountNativeAuth(fs, aiHomeDir, account2Ref, { auth: { openai: { type: 'api', key: 'b' } } });

  assert.deepEqual(
    listAccountCredentialRecords(fs, aiHomeDir, 'opencode').map((record) => record.accountRef),
    [account2Ref, account10Ref].sort()
  );
  assert.deepEqual(
    listCliAccountCredentialRecords(fs, aiHomeDir, 'opencode')
      .map((record) => [record.cliAccountId, record.accountRef]),
    [['2', account2Ref], ['10', account10Ref]]
  );
  assert.equal(deleteAccountCredentials(fs, aiHomeDir, account2Ref), true);
  assert.deepEqual(
    listAccountCredentialRecords(fs, aiHomeDir, 'opencode').map((record) => record.accountRef),
    [account10Ref]
  );
});

test('credential reads depend on accountRef rather than the CLI selector', (t) => {
  const { aiHomeDir } = createStoreFixture(t);
  const accountRef = registerAccount(aiHomeDir, 'gemini', '3');
  writeAccountCredentials(fs, aiHomeDir, accountRef, { GEMINI_API_KEY: 'db-key' });

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(aiHomeDir, 'app-state.db'));
  try {
    db.prepare('DELETE FROM account_cli_aliases WHERE account_ref = ?').run(accountRef);
  } finally {
    db.close();
  }

  assert.deepEqual(readAccountCredentialRecord(fs, aiHomeDir, accountRef).env, {
    GEMINI_API_KEY: 'db-key'
  });
  assert.deepEqual(
    listAccountCredentialRecords(fs, aiHomeDir, 'gemini').map((record) => record.accountRef),
    [accountRef]
  );
  assert.deepEqual(listCliAccountCredentialRecords(fs, aiHomeDir, 'gemini'), []);
});

test('credential store rejects legacy account_id schema without mutating it', (t) => {
  const { aiHomeDir } = createStoreFixture(t);
  registerAccount(aiHomeDir, 'codex', '7');
  const db = openAppStateDatabase(fs, aiHomeDir);
  try {
    db.exec(`
      CREATE TABLE account_credentials (
        account_id TEXT PRIMARY KEY,
        credentials_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.prepare(`
      INSERT INTO account_credentials (account_id, credentials_json, updated_at)
      VALUES (?, ?, ?)
    `).run('7', '{"OPENAI_API_KEY":"legacy"}', 123);

    assert.throws(
      () => ensureCredentialTable(db),
      /account_credential_schema_invalid/
    );
    assert.deepEqual(
      db.prepare('PRAGMA table_info(account_credentials)').all().map((row) => row.name),
      ['account_id', 'credentials_json', 'updated_at']
    );
    assert.deepEqual(
      db.prepare('SELECT * FROM account_credentials').all().map((row) => ({ ...row })),
      [{ account_id: '7', credentials_json: '{"OPENAI_API_KEY":"legacy"}', updated_at: 123 }]
    );
  } finally {
    db.close();
  }
});
