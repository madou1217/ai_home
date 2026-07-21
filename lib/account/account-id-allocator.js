'use strict';

const {
  ensureExactTableSchema,
  openAppStateDatabase
} = require('../server/app-state-store');
const {
  CLI_ACCOUNT_ALIASES_TABLE,
  ensureCliAccountAliasesTable
} = require('../server/account-ref-store');

const CLI_ACCOUNT_ID_SEQUENCE_TABLE = 'cli_account_id_sequences';
const CLI_ACCOUNT_ID_SEQUENCE_COLUMNS = Object.freeze([
  'provider',
  'next_id',
  'updated_at'
]);
const ACCOUNT_PROVIDERS = new Set(['agy', 'claude', 'codex', 'gemini', 'opencode', 'grok', 'qoder', 'qodercn']);

function normalizeProvider(provider) {
  const value = String(provider || '').trim().toLowerCase();
  return ACCOUNT_PROVIDERS.has(value) ? value : '';
}

function ensureSequenceTable(db) {
  ensureExactTableSchema(db, {
    tableName: CLI_ACCOUNT_ID_SEQUENCE_TABLE,
    columns: CLI_ACCOUNT_ID_SEQUENCE_COLUMNS,
    primaryKey: ['provider'],
    create: () => db.exec(`
      CREATE TABLE IF NOT EXISTS ${CLI_ACCOUNT_ID_SEQUENCE_TABLE} (
        provider TEXT PRIMARY KEY,
        next_id INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `),
    errorCode: 'cli_account_id_sequence_schema_invalid'
  });
}

function readMaxAssignedCliAccountId(db, provider) {
  const row = db.prepare(`
    SELECT MAX(CAST(cli_account_id AS INTEGER)) AS max_id
    FROM ${CLI_ACCOUNT_ALIASES_TABLE}
    WHERE provider = ?
  `).get(provider);
  const value = Number(row && row.max_id);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function readStoredNextId(db, provider) {
  const row = db.prepare(`
    SELECT next_id
    FROM ${CLI_ACCOUNT_ID_SEQUENCE_TABLE}
    WHERE provider = ?
  `).get(provider);
  const nextId = Number(row && row.next_id);
  return Number.isSafeInteger(nextId) && nextId > 0 ? nextId : 0;
}

function writeStoredNextId(db, provider, nextId, now = Date.now()) {
  db.prepare(`
    INSERT INTO ${CLI_ACCOUNT_ID_SEQUENCE_TABLE} (provider, next_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET
      next_id = excluded.next_id,
      updated_at = excluded.updated_at
  `).run(provider, nextId, Number(now) || Date.now());
}

function initializeNextId(db, provider, now = Date.now()) {
  const storedNextId = readStoredNextId(db, provider);
  if (storedNextId) return storedNextId;
  const nextId = readMaxAssignedCliAccountId(db, provider) + 1;
  writeStoredNextId(db, provider, nextId, now);
  return nextId;
}

function advanceCliAccountIdSequenceInDatabase(db, provider, cliAccountId, now = Date.now()) {
  const normalizedProvider = normalizeProvider(provider);
  const assignedId = Number(cliAccountId);
  if (!normalizedProvider || !Number.isSafeInteger(assignedId) || assignedId < 1) {
    throw new Error('invalid_cli_account_id');
  }
  if (!db || typeof db.prepare !== 'function') throw new Error('cli_account_id_database_unavailable');
  ensureCliAccountAliasesTable(db);
  ensureSequenceTable(db);
  const nextId = Math.max(initializeNextId(db, normalizedProvider, now), assignedId + 1);
  if (!Number.isSafeInteger(nextId) || nextId >= Number.MAX_SAFE_INTEGER) {
    throw new Error('cli_account_id_space_exhausted');
  }
  writeStoredNextId(db, normalizedProvider, nextId, now);
  return nextId;
}

function allocateCliAccountIdInDatabase(db, provider, now = Date.now()) {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) throw new Error('unsupported_cli_account_id_provider');
  if (!db || typeof db.prepare !== 'function') throw new Error('cli_account_id_database_unavailable');
  ensureCliAccountAliasesTable(db);
  ensureSequenceTable(db);
  const candidate = initializeNextId(db, normalizedProvider, now);
  if (!Number.isSafeInteger(candidate) || candidate >= Number.MAX_SAFE_INTEGER) {
    throw new Error('cli_account_id_space_exhausted');
  }
  writeStoredNextId(db, normalizedProvider, candidate + 1, now);
  return String(candidate);
}

function allocateCliAccountId(fs, aiHomeDir, provider) {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) throw new Error('unsupported_cli_account_id_provider');
  let db = null;
  try {
    db = openAppStateDatabase(fs, aiHomeDir);
    if (!db) throw new Error('cli_account_id_database_unavailable');
    ensureCliAccountAliasesTable(db);
    ensureSequenceTable(db);
    db.exec('BEGIN IMMEDIATE');
    try {
      const cliAccountId = allocateCliAccountIdInDatabase(db, normalizedProvider);
      db.exec('COMMIT');
      return cliAccountId;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_rollbackError) {}
      throw error;
    }
  } finally {
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch (_closeError) {}
    }
  }
}

module.exports = {
  CLI_ACCOUNT_ID_SEQUENCE_TABLE,
  advanceCliAccountIdSequenceInDatabase,
  allocateCliAccountId,
  allocateCliAccountIdInDatabase,
  ensureSequenceTable,
  readMaxAssignedCliAccountId
};
