'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  ensureAccountRefsTable,
  ensureCliAccountAliasesTable,
  getPublicAccountRef,
  isAccountRef,
  listAccountRefRecords,
  listCliAccountRefRecords,
  resolveAccountRef,
  upsertAccountRef
} = require('../lib/server/account-ref-store');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { getAppStateDbPath, openAppStateDatabase } = require('../lib/server/app-state-store');

test('account ref is stable and hides internal account identity', () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-ref-'));
  try {
    const account = {
      provider: 'codex',
      cliAccountId: '3',
      identitySeed: 'oauth:codex:hidden@example.com'
    };
    const first = registerAccountIdentity(fs, aiHomeDir, account);
    const second = registerAccountIdentity(fs, aiHomeDir, { ...account, cliAccountId: '9' });

    assert.equal(first.accountRef, second.accountRef);
    assert.equal(second.cliAccountId, '3');
    assert.equal(isAccountRef(first.accountRef), true);
    assert.equal(first.accountRef.includes('hidden@example.com'), false);
    assert.equal(first.accountRef.includes('oauth:codex'), false);
    assert.equal(first.accountRef.includes('codex:3'), false);
    assert.equal(fs.existsSync(getAppStateDbPath(aiHomeDir)), true);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('low-level accountRef upsert cannot reassign an existing CLI alias', () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-ref-alias-'));
  try {
    const identitySeed = 'oauth:gemini:stable@example.com';
    const firstRef = upsertAccountRef(fs, aiHomeDir, {
      provider: 'gemini',
      cliAccountId: '4',
      identitySeed
    });
    const secondRef = upsertAccountRef(fs, aiHomeDir, {
      provider: 'gemini',
      cliAccountId: '99',
      identitySeed
    });

    assert.equal(secondRef, firstRef);
    assert.deepEqual(
      listCliAccountRefRecords(fs, aiHomeDir, 'gemini').map((record) => record.cliAccountId),
      ['4']
    );
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('concurrent registration keeps one accountRef and one immutable CLI alias', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-ref-concurrent-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const registrationModule = path.join(__dirname, '..', 'lib', 'account', 'account-registration.js');
  const worker = [
    "const fs = require('node:fs');",
    `const { registerAccountIdentity } = require(${JSON.stringify(registrationModule)});`,
    `const result = registerAccountIdentity(fs, ${JSON.stringify(aiHomeDir)}, {`,
    "  provider: 'opencode',",
    "  identitySeed: 'oauth:opencode:concurrent@example.com'",
    '});',
    'process.stdout.write(JSON.stringify(result));'
  ].join('\n');

  const runWorker = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', worker], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`registration worker failed (${code}): ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });

  const registrations = await Promise.all(Array.from({ length: 6 }, runWorker));
  assert.equal(new Set(registrations.map((item) => item.accountRef)).size, 1);
  assert.equal(new Set(registrations.map((item) => item.cliAccountId)).size, 1);
  assert.equal(registrations.filter((item) => item.created).length, 1);
  assert.equal(listCliAccountRefRecords(fs, aiHomeDir, 'opencode').length, 1);
});

test('account ref resolves to internal scope from app state database', () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-ref-resolve-'));
  try {
    const accountRef = registerAccountIdentity(fs, aiHomeDir, {
      provider: 'gemini',
      cliAccountId: '1',
      identitySeed: 'oauth:gemini:user@example.com'
    }).accountRef;

    const resolved = resolveAccountRef(fs, aiHomeDir, accountRef);

    assert.equal(resolved.accountRef, accountRef);
    assert.equal(resolved.provider, 'gemini');
    assert.equal(Object.prototype.hasOwnProperty.call(resolved, 'cliAccountId'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(resolved, 'accountId'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(resolved, 'accountKey'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(resolved, 'uniqueKey'), false);

    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(getAppStateDbPath(aiHomeDir));
    const columns = db.prepare('PRAGMA table_info(account_refs)').all().map((row) => row.name);
    db.close();
    assert.deepEqual(columns, ['account_ref', 'provider', 'created_at', 'updated_at']);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('account ref schema rejects legacy combined columns without mutating data', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-ref-schema-invalid-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = getPublicAccountRef('legacy-schema:codex:1');
  const db = openAppStateDatabase(fs, aiHomeDir);
  try {
    db.exec(`
      CREATE TABLE account_refs (
        account_ref TEXT PRIMARY KEY,
        identity_key TEXT NOT NULL UNIQUE,
        unique_key TEXT NOT NULL,
        provider TEXT NOT NULL,
        account_id TEXT NOT NULL,
        account_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const insertAccount = db.prepare(`
      INSERT INTO account_refs (
        account_ref, identity_key, unique_key, provider,
        account_id, account_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertAccount.run(accountRef, 'identity:codex:1', 'oauth:codex:user@example.com', 'codex', '7', 'codex:7', 10, 20);

    assert.throws(
      () => ensureAccountRefsTable(db),
      /account_ref_schema_invalid/
    );
    assert.deepEqual(
      db.prepare('PRAGMA table_info(account_refs)').all().map((row) => row.name),
      [
        'account_ref',
        'identity_key',
        'unique_key',
        'provider',
        'account_id',
        'account_key',
        'created_at',
        'updated_at'
      ]
    );
    assert.deepEqual(
      db.prepare('SELECT * FROM account_refs').all().map((row) => ({ ...row })),
      [{
        account_ref: accountRef,
        identity_key: 'identity:codex:1',
        unique_key: 'oauth:codex:user@example.com',
        provider: 'codex',
        account_id: '7',
        account_key: 'codex:7',
        created_at: 10,
        updated_at: 20
      }]
    );
    assert.equal(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'account_cli_aliases'
    `).get(), undefined);
  } finally {
    db.close();
  }
});

test('account ref schema requires account_ref to be the database primary key', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-ref-primary-key-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const db = openAppStateDatabase(fs, aiHomeDir);
  try {
    db.exec(`
      CREATE TABLE account_refs (
        account_ref TEXT NOT NULL,
        provider TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    assert.throws(
      () => ensureAccountRefsTable(db),
      /account_ref_schema_invalid/
    );
    assert.deepEqual(
      db.prepare('PRAGMA table_info(account_refs)').all().map((row) => [row.name, row.pk]),
      [
        ['account_ref', 0],
        ['provider', 0],
        ['created_at', 0],
        ['updated_at', 0]
      ]
    );
  } finally {
    db.close();
  }
});

test('CLI account alias schema requires one selector per provider', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-alias-unique-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const db = openAppStateDatabase(fs, aiHomeDir);
  try {
    ensureAccountRefsTable(db);
    db.exec(`
      CREATE TABLE account_cli_aliases (
        account_ref TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        cli_account_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(account_ref) REFERENCES account_refs(account_ref) ON DELETE CASCADE
      )
    `);

    assert.throws(
      () => ensureCliAccountAliasesTable(db),
      /account_cli_alias_schema_invalid/
    );
  } finally {
    db.close();
  }
});

test('account ref store refuses a stale combined schema without deleting split aliases', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-ref-schema-regression-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = getPublicAccountRef('schema-regression:codex:1');
  const db = openAppStateDatabase(fs, aiHomeDir);
  try {
    ensureCliAccountAliasesTable(db);
    db.prepare(`
      INSERT INTO account_refs (account_ref, provider, created_at, updated_at)
      VALUES (?, 'codex', 10, 20)
    `).run(accountRef);
    db.prepare(`
      INSERT INTO account_cli_aliases (
        account_ref, provider, cli_account_id, created_at, updated_at
      ) VALUES (?, 'codex', '1', 10, 20)
    `).run(accountRef);

    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`
      DROP TABLE account_refs;
      CREATE TABLE account_refs (
        account_ref TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        cli_account_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db.exec('PRAGMA foreign_keys = ON');

    assert.throws(
      () => ensureAccountRefsTable(db),
      /account_ref_schema_invalid/
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM account_refs').get().count, 0);
    assert.deepEqual(
      db.prepare('SELECT account_ref, provider, cli_account_id FROM account_cli_aliases').all()
        .map((row) => ({ ...row })),
      [{ account_ref: accountRef, provider: 'codex', cli_account_id: '1' }]
    );
  } finally {
    db.close();
  }
});

test('account ref store refuses a stale combined schema even when the split alias table is empty', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-ref-empty-schema-regression-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const db = openAppStateDatabase(fs, aiHomeDir);
  try {
    ensureCliAccountAliasesTable(db);
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`
      DROP TABLE account_refs;
      CREATE TABLE account_refs (
        account_ref TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        cli_account_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db.exec('PRAGMA foreign_keys = ON');

    assert.throws(
      () => ensureAccountRefsTable(db),
      /account_ref_schema_invalid/
    );
    assert.deepEqual(
      db.prepare('PRAGMA table_info(account_refs)').all().map((row) => row.name),
      ['account_ref', 'provider', 'cli_account_id', 'created_at', 'updated_at']
    );
  } finally {
    db.close();
  }
});

test('accountRef lookup is independent from the CLI selector column', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-ref-gateway-row-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const db = openAppStateDatabase(fs, aiHomeDir);
  const syntheticRef = 'acct_00000000000000000000';
  try {
    ensureCliAccountAliasesTable(db);
    db.prepare(`
      INSERT INTO account_refs (account_ref, provider, created_at, updated_at)
      VALUES (?, 'codex', 1, 1)
    `).run(syntheticRef);
    assert.throws(
      () => db.prepare(`
        INSERT INTO account_cli_aliases (
          account_ref, provider, cli_account_id, created_at, updated_at
        ) VALUES (?, 'codex', '.aih-server', 1, 1)
      `).run(syntheticRef),
      /constraint/i
    );
  } finally {
    db.close();
  }

  assert.deepEqual(resolveAccountRef(fs, aiHomeDir, syntheticRef), {
    accountRef: syntheticRef,
    provider: 'codex',
    createdAt: 1,
    updatedAt: 1
  });
  assert.deepEqual(listCliAccountRefRecords(fs, aiHomeDir, 'codex'), []);
  assert.deepEqual(listAccountRefRecords(fs, aiHomeDir, 'codex'), [{
    accountRef: syntheticRef,
    provider: 'codex',
    createdAt: 1,
    updatedAt: 1
  }]);
});

test('business account schema does not require or create the CLI alias table', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-ref-domain-only-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const db = openAppStateDatabase(fs, aiHomeDir);
  try {
    ensureAccountRefsTable(db);
    const aliasTable = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'account_cli_aliases'
    `).get();
    assert.equal(aliasTable, undefined);
  } finally {
    db.close();
  }
});
