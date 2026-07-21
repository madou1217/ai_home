'use strict';

const {
  ensureExactTableSchema,
  openAppStateDatabase
} = require('./app-state-store');
const {
  ensureAccountRefsTable,
  isAccountRef,
  resolveAccountRef
} = require('./account-ref-store');

const ACCOUNT_CREDENTIAL_TABLE = 'account_credentials';
const ACCOUNT_CREDENTIAL_COLUMNS = Object.freeze([
  'account_ref',
  'env_json',
  'native_auth_json',
  'env_updated_at',
  'native_auth_updated_at',
  'updated_at'
]);
const ACCOUNT_PROVIDERS = new Set(['agy', 'claude', 'codex', 'gemini', 'opencode', 'grok', 'qoder', 'qodercn', 'kimi', 'kiro']);

function normalizeProvider(provider) {
  const value = String(provider || '').trim().toLowerCase();
  return ACCOUNT_PROVIDERS.has(value) ? value : '';
}

function normalizeAccountRef(accountRef) {
  const value = String(accountRef || '').trim();
  return isAccountRef(value) ? value : '';
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isNonEmptyObject(value) {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function parseObject(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    return isPlainObject(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function createCredentialTable(db, tableName = ACCOUNT_CREDENTIAL_TABLE) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      account_ref TEXT PRIMARY KEY,
      env_json TEXT NOT NULL DEFAULT '{}',
      native_auth_json TEXT NOT NULL DEFAULT '{}',
      env_updated_at INTEGER NOT NULL DEFAULT 0,
      native_auth_updated_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(account_ref) REFERENCES account_refs(account_ref) ON DELETE CASCADE
    )
  `);
}

function ensureCredentialTable(db) {
  ensureAccountRefsTable(db);
  ensureExactTableSchema(db, {
    tableName: ACCOUNT_CREDENTIAL_TABLE,
    columns: ACCOUNT_CREDENTIAL_COLUMNS,
    primaryKey: ['account_ref'],
    create: () => createCredentialTable(db),
    errorCode: 'account_credential_schema_invalid'
  });
}

function withCredentialDatabase(fs, aiHomeDir, callback, options = {}) {
  let db = null;
  try {
    db = openAppStateDatabase(fs, aiHomeDir, {
      createIfMissing: options.createIfMissing !== false
    });
    if (!db) return null;
    ensureCredentialTable(db);
    return callback(db);
  } finally {
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch (_closeError) {}
    }
  }
}

function mapCredentialRow(row) {
  if (!row) return null;
  const accountRef = normalizeAccountRef(row.account_ref);
  const provider = normalizeProvider(row.provider);
  if (!accountRef || !provider) return null;
  return {
    accountRef,
    provider,
    env: parseObject(row.env_json),
    nativeAuth: parseObject(row.native_auth_json),
    envUpdatedAt: Number(row.env_updated_at) || 0,
    nativeAuthUpdatedAt: Number(row.native_auth_updated_at) || 0,
    updatedAt: Number(row.updated_at) || 0
  };
}

function readAccountCredentialRecord(fs, aiHomeDir, accountRef) {
  const normalizedRef = normalizeAccountRef(accountRef);
  if (!normalizedRef) return null;
  const row = withCredentialDatabase(fs, aiHomeDir, (db) => db.prepare(`
    SELECT c.account_ref, r.provider,
           c.env_json, c.native_auth_json,
           c.env_updated_at, c.native_auth_updated_at, c.updated_at
    FROM ${ACCOUNT_CREDENTIAL_TABLE} c
    INNER JOIN account_refs r ON r.account_ref = c.account_ref
    WHERE c.account_ref = ?
    LIMIT 1
  `).get(normalizedRef), { createIfMissing: false });
  return mapCredentialRow(row);
}

function upsertCredentialPart(fs, aiHomeDir, accountRef, column, value) {
  const normalizedRef = normalizeAccountRef(accountRef);
  if (!normalizedRef || !resolveAccountRef(fs, aiHomeDir, normalizedRef)) {
    throw new Error('unknown_account_ref');
  }
  if (column !== 'env_json' && column !== 'native_auth_json') {
    throw new Error('invalid_account_credential_column');
  }
  const normalizedValue = isPlainObject(value) ? value : {};
  const now = Date.now();
  const timestampColumn = column === 'env_json' ? 'env_updated_at' : 'native_auth_updated_at';
  const result = withCredentialDatabase(fs, aiHomeDir, (db) => db.prepare(`
    INSERT INTO ${ACCOUNT_CREDENTIAL_TABLE} (
      account_ref, ${column}, ${timestampColumn}, updated_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(account_ref) DO UPDATE SET
      ${column} = excluded.${column},
      ${timestampColumn} = excluded.${timestampColumn},
      updated_at = excluded.updated_at
  `).run(normalizedRef, JSON.stringify(normalizedValue), now, now));
  if (!result) throw new Error('account_credential_write_failed');
  return true;
}

function readAccountCredentials(fs, aiHomeDir, accountRef) {
  const record = readAccountCredentialRecord(fs, aiHomeDir, accountRef);
  return record ? record.env : {};
}

function readAccountNativeAuth(fs, aiHomeDir, accountRef) {
  const record = readAccountCredentialRecord(fs, aiHomeDir, accountRef);
  return record ? record.nativeAuth : {};
}

function readNonEmptyAccountCredentials(fs, aiHomeDir, accountRef) {
  const credentials = readAccountCredentials(fs, aiHomeDir, accountRef);
  return isNonEmptyObject(credentials) ? credentials : null;
}

function readNonEmptyAccountNativeAuth(fs, aiHomeDir, accountRef) {
  const nativeAuth = readAccountNativeAuth(fs, aiHomeDir, accountRef);
  return isNonEmptyObject(nativeAuth) ? nativeAuth : null;
}

function writeAccountCredentials(fs, aiHomeDir, accountRef, data) {
  return upsertCredentialPart(fs, aiHomeDir, accountRef, 'env_json', data);
}

function writeAccountNativeAuth(fs, aiHomeDir, accountRef, data) {
  return upsertCredentialPart(fs, aiHomeDir, accountRef, 'native_auth_json', data);
}

function deleteAccountCredentials(fs, aiHomeDir, accountRef) {
  const normalizedRef = normalizeAccountRef(accountRef);
  if (!normalizedRef) return false;
  const result = withCredentialDatabase(fs, aiHomeDir, (db) => db.prepare(`
    DELETE FROM ${ACCOUNT_CREDENTIAL_TABLE}
    WHERE account_ref = ?
  `).run(normalizedRef), { createIfMissing: false });
  return Number(result && result.changes) > 0;
}

function hasAccountCredentials(fs, aiHomeDir, accountRef) {
  const record = readAccountCredentialRecord(fs, aiHomeDir, accountRef);
  return Boolean(record && (isNonEmptyObject(record.env) || isNonEmptyObject(record.nativeAuth)));
}

function listAccountCredentialRecords(fs, aiHomeDir, provider = '') {
  const normalizedProvider = provider ? normalizeProvider(provider) : '';
  if (provider && !normalizedProvider) return [];
  const rows = withCredentialDatabase(fs, aiHomeDir, (db) => {
    const sql = `
      SELECT c.account_ref, r.provider,
             c.env_json, c.native_auth_json,
             c.env_updated_at, c.native_auth_updated_at, c.updated_at
      FROM ${ACCOUNT_CREDENTIAL_TABLE} c
      INNER JOIN account_refs r ON r.account_ref = c.account_ref
      WHERE (c.env_json <> '{}' OR c.native_auth_json <> '{}')
      ${normalizedProvider ? 'AND r.provider = ?' : ''}
      ORDER BY r.provider, c.account_ref
    `;
    return normalizedProvider ? db.prepare(sql).all(normalizedProvider) : db.prepare(sql).all();
  }, { createIfMissing: false }) || [];
  return rows.map(mapCredentialRow).filter(Boolean);
}

module.exports = {
  ACCOUNT_CREDENTIAL_TABLE,
  deleteAccountCredentials,
  ensureCredentialTable,
  hasAccountCredentials,
  isNonEmptyCredentialData: isNonEmptyObject,
  listAccountCredentialRecords,
  readAccountCredentialRecord,
  readAccountCredentials,
  readAccountNativeAuth,
  readNonEmptyAccountCredentials,
  readNonEmptyAccountNativeAuth,
  writeAccountCredentials,
  writeAccountNativeAuth
};
