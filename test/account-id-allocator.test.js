'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  allocateCliAccountId
} = require('../lib/account/account-id-allocator');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { openAppStateDatabase } = require('../lib/server/app-state-store');

function createFixture(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-id-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  return aiHomeDir;
}

function registerAccount(aiHomeDir, provider, cliAccountId) {
  return upsertAccountRef(fs, aiHomeDir, {
    provider,
    cliAccountId,
    identitySeed: `oauth:${provider}:allocator-${cliAccountId}@example.com`
  });
}

test('CLI account id allocator seeds from account refs without creating profile directories', (t) => {
  const aiHomeDir = createFixture(t);
  registerAccount(aiHomeDir, 'gemini', '1');
  registerAccount(aiHomeDir, 'gemini', '9');

  const first = allocateCliAccountId(fs, aiHomeDir, 'gemini');
  const second = allocateCliAccountId(fs, aiHomeDir, 'gemini');

  assert.equal(first, '10');
  assert.equal(second, '11');
  assert.equal(fs.existsSync(path.join(aiHomeDir, 'profiles', 'gemini', '10')), false);
});

test('account id sequences are isolated by provider and persist across connections', (t) => {
  const aiHomeDir = createFixture(t);

  assert.equal(allocateCliAccountId(fs, aiHomeDir, 'agy'), '1');
  assert.equal(allocateCliAccountId(fs, aiHomeDir, 'opencode'), '1');
  assert.equal(allocateCliAccountId(fs, aiHomeDir, 'agy'), '2');
});

test('account id allocator validates providers and advances from the largest DB alias', (t) => {
  const aiHomeDir = createFixture(t);
  registerAccount(aiHomeDir, 'codex', '20000');

  assert.equal(allocateCliAccountId(fs, aiHomeDir, 'codex'), '20001');
  assert.throws(
    () => allocateCliAccountId(fs, aiHomeDir, 'unsupported'),
    /unsupported_cli_account_id_provider/
  );
});

test('explicit CLI account ids advance an initialized sequence', (t) => {
  const aiHomeDir = createFixture(t);

  assert.equal(allocateCliAccountId(fs, aiHomeDir, 'gemini'), '1');
  registerAccountIdentity(fs, aiHomeDir, {
    provider: 'gemini',
    cliAccountId: '500000',
    identitySeed: 'oauth:gemini:explicit-sequence@example.com'
  });

  assert.equal(allocateCliAccountId(fs, aiHomeDir, 'gemini'), '500001');
});

test('CLI account id allocator rejects incompatible sequence schema without mutating it', (t) => {
  const aiHomeDir = createFixture(t);
  registerAccount(aiHomeDir, 'agy', '1');
  const db = openAppStateDatabase(fs, aiHomeDir);
  try {
    db.exec(`
      CREATE TABLE cli_account_id_sequences (
        provider TEXT PRIMARY KEY,
        account_id INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.prepare(`
      INSERT INTO cli_account_id_sequences (provider, account_id, updated_at)
      VALUES (?, ?, ?)
    `).run('agy', 2, 789);
  } finally {
    db.close();
  }

  assert.throws(
    () => allocateCliAccountId(fs, aiHomeDir, 'agy'),
    /cli_account_id_sequence_schema_invalid/
  );

  const { DatabaseSync } = require('node:sqlite');
  const inspectionDb = new DatabaseSync(path.join(aiHomeDir, 'app-state.db'));
  try {
    assert.deepEqual(
      inspectionDb.prepare('PRAGMA table_info(cli_account_id_sequences)').all().map((row) => row.name),
      ['provider', 'account_id', 'updated_at']
    );
    assert.deepEqual(
      inspectionDb.prepare('SELECT * FROM cli_account_id_sequences').all().map((row) => ({ ...row })),
      [{ provider: 'agy', account_id: 2, updated_at: 789 }]
    );
  } finally {
    inspectionDb.close();
  }
});
