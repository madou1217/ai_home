'use strict';

const {
  ACCOUNT_REF_PREFIX,
  getPublicAccountRef,
  isAccountRef
} = require('../account/public-account-ref');
const {
  ensureExactTableSchema,
  openAppStateDatabase
} = require('./app-state-store');

const ACCOUNT_PROVIDERS = new Set(['agy', 'claude', 'codex', 'gemini', 'opencode']);
const ACCOUNT_REFS_TABLE = 'account_refs';
const CLI_ACCOUNT_ALIASES_TABLE = 'account_cli_aliases';
const ACCOUNT_REFS_COLUMNS = Object.freeze([
  'account_ref',
  'provider',
  'created_at',
  'updated_at'
]);
const CLI_ACCOUNT_ALIASES_COLUMNS = Object.freeze([
  'account_ref',
  'provider',
  'cli_account_id',
  'created_at',
  'updated_at'
]);

function normalizeProvider(provider) {
  const value = String(provider || '').trim().toLowerCase();
  return ACCOUNT_PROVIDERS.has(value) ? value : '';
}

function getCliAccountId(account) {
  return String(account && account.cliAccountId || '').trim();
}

function normalizeAccountRefRecord(input) {
  const provider = normalizeProvider(input && input.provider);
  const cliAccountId = getCliAccountId(input);
  const identitySeed = String(input && input.identitySeed || '').trim();
  if (!provider || !/^\d+$/.test(cliAccountId) || !identitySeed || identitySeed.startsWith('legacy:')) return null;
  const accountRef = getPublicAccountRef(`unique:${identitySeed}`);
  return {
    accountRef,
    provider,
    cliAccountId
  };
}

function createAccountRefsTable(db, tableName = 'account_refs') {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      account_ref TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

function createCliAccountAliasesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${CLI_ACCOUNT_ALIASES_TABLE} (
      account_ref TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      cli_account_id TEXT NOT NULL
        CHECK (cli_account_id <> '' AND cli_account_id NOT GLOB '*[^0-9]*'),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(provider, cli_account_id),
      FOREIGN KEY(account_ref) REFERENCES account_refs(account_ref) ON DELETE CASCADE
    )
  `);
}

function ensureAccountRefsTable(db) {
  ensureExactTableSchema(db, {
    tableName: ACCOUNT_REFS_TABLE,
    columns: ACCOUNT_REFS_COLUMNS,
    primaryKey: ['account_ref'],
    create: () => createAccountRefsTable(db),
    errorCode: 'account_ref_schema_invalid'
  });
  db.exec('CREATE INDEX IF NOT EXISTS idx_account_refs_provider ON account_refs(provider, updated_at)');
}

function ensureCliAccountAliasesTable(db) {
  ensureAccountRefsTable(db);
  ensureExactTableSchema(db, {
    tableName: CLI_ACCOUNT_ALIASES_TABLE,
    columns: CLI_ACCOUNT_ALIASES_COLUMNS,
    primaryKey: ['account_ref'],
    uniqueKeys: [['provider', 'cli_account_id']],
    create: () => createCliAccountAliasesTable(db),
    errorCode: 'account_cli_alias_schema_invalid'
  });
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_account_cli_aliases_provider_id
      ON ${CLI_ACCOUNT_ALIASES_TABLE}(provider, cli_account_id, updated_at)
  `);
}

function upsertAccountRefRecordInDatabase(db, input = {}) {
  const accountRef = String(input.accountRef || '').trim();
  const provider = normalizeProvider(input.provider);
  const requestedCliAccountId = String(input.cliAccountId || '').trim();
  if (!db || !isAccountRef(accountRef) || !provider || !/^\d+$/.test(requestedCliAccountId)) return '';
  ensureCliAccountAliasesTable(db);
  const now = Number(input.now) || Date.now();
  db.exec('SAVEPOINT account_ref_upsert');
  try {
    const previous = db.prepare('SELECT provider, created_at FROM account_refs WHERE account_ref = ?').get(accountRef);
    if (previous && normalizeProvider(previous.provider) !== provider) {
      db.exec('RELEASE account_ref_upsert');
      return '';
    }
    const previousAlias = db.prepare(`
      SELECT cli_account_id, created_at
      FROM ${CLI_ACCOUNT_ALIASES_TABLE}
      WHERE account_ref = ?
    `).get(accountRef);
    const cliAccountId = String(previousAlias && previousAlias.cli_account_id || requestedCliAccountId).trim();
    const occupied = db.prepare(`
      SELECT account_ref
      FROM ${CLI_ACCOUNT_ALIASES_TABLE}
      WHERE provider = ? AND cli_account_id = ?
    `).get(provider, cliAccountId);
    if (occupied && String(occupied.account_ref || '') !== accountRef) {
      db.exec('RELEASE account_ref_upsert');
      return '';
    }
    db.prepare(`
      INSERT INTO account_refs (
        account_ref, provider, created_at, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(account_ref) DO UPDATE SET
        updated_at = excluded.updated_at
    `).run(accountRef, provider, Number(previous && previous.created_at) || now, now);
    db.prepare(`
      INSERT INTO ${CLI_ACCOUNT_ALIASES_TABLE} (
        account_ref, provider, cli_account_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_ref) DO UPDATE SET
        updated_at = excluded.updated_at
    `).run(
      accountRef,
      provider,
      cliAccountId,
      Number(previousAlias && previousAlias.created_at) || now,
      now
    );
    db.exec('RELEASE account_ref_upsert');
    return accountRef;
  } catch (error) {
    try { db.exec('ROLLBACK TO account_ref_upsert'); } catch (_rollbackError) {}
    try { db.exec('RELEASE account_ref_upsert'); } catch (_releaseError) {}
    throw error;
  }
}

function mapAccountRefRow(row) {
  if (!row) return null;
  const accountRef = String(row.account_ref || '').trim();
  const provider = normalizeProvider(row.provider);
  if (!isAccountRef(accountRef) || !provider) return null;
  return {
    accountRef,
    provider,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0
  };
}

function mapCliAccountRefRow(row) {
  if (!row) return null;
  const record = mapAccountRefRow(row);
  const cliAccountId = String(row.cli_account_id || '').trim();
  if (!record || !/^\d+$/.test(cliAccountId)) return null;
  return {
    ...record,
    cliAccountId
  };
}

function upsertAccountRef(fs, aiHomeDir, account, deps = {}) {
  const record = normalizeAccountRefRecord(account);
  if (!record) return '';
  let db = null;
  try {
    db = openAppStateDatabase(fs, aiHomeDir, deps);
    if (!db) return '';
    ensureAccountRefsTable(db);
    return upsertAccountRefRecordInDatabase(db, record);
  } catch (error) {
    if (!deps.bestEffort) throw error;
    return '';
  } finally {
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch (_error) {}
    }
  }
}

function resolveAccountRef(fs, aiHomeDir, accountRef, deps = {}) {
  const normalizedRef = String(accountRef || '').trim();
  if (!isAccountRef(normalizedRef)) return null;
  let db = null;
  try {
    db = openAppStateDatabase(fs, aiHomeDir, { ...deps, createIfMissing: false });
    if (!db) return null;
    ensureAccountRefsTable(db);
    const row = db.prepare(`
      SELECT account_ref, provider, created_at, updated_at
      FROM account_refs
      WHERE account_ref = ?
    `).get(normalizedRef);
    return mapAccountRefRow(row);
  } catch (error) {
    if (!deps.bestEffort) throw error;
    return null;
  } finally {
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch (_error) {}
    }
  }
}

function listAccountRefRecords(fs, aiHomeDir, provider = '', deps = {}) {
  const normalizedProvider = provider ? normalizeProvider(provider) : '';
  if (provider && !normalizedProvider) return [];
  let db = null;
  try {
    db = openAppStateDatabase(fs, aiHomeDir, { ...deps, createIfMissing: false });
    if (!db) return [];
    ensureAccountRefsTable(db);
    const rows = normalizedProvider
      ? db.prepare(`
        SELECT account_ref, provider, created_at, updated_at
        FROM account_refs
        WHERE provider = ?
        ORDER BY account_ref
      `).all(normalizedProvider)
      : db.prepare(`
        SELECT account_ref, provider, created_at, updated_at
        FROM account_refs
        ORDER BY provider, account_ref
      `).all();
    return (rows || []).map(mapAccountRefRow).filter(Boolean);
  } catch (error) {
    if (!deps.bestEffort) throw error;
    return [];
  } finally {
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch (_error) {}
    }
  }
}

function resolveCliAccountRef(fs, aiHomeDir, accountRef, deps = {}) {
  const normalizedRef = String(accountRef || '').trim();
  if (!isAccountRef(normalizedRef)) return null;
  let db = null;
  try {
    db = openAppStateDatabase(fs, aiHomeDir, { ...deps, createIfMissing: false });
    if (!db) return null;
    ensureCliAccountAliasesTable(db);
    const row = db.prepare(`
      SELECT r.account_ref, r.provider, a.cli_account_id, r.created_at, r.updated_at
      FROM account_refs r
      INNER JOIN ${CLI_ACCOUNT_ALIASES_TABLE} a ON a.account_ref = r.account_ref
      WHERE r.account_ref = ?
    `).get(normalizedRef);
    return mapCliAccountRefRow(row);
  } catch (error) {
    if (!deps.bestEffort) throw error;
    return null;
  } finally {
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch (_error) {}
    }
  }
}

function resolveAccountRefByCliId(fs, aiHomeDir, provider, cliAccountId, deps = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedCliAccountId = String(cliAccountId || '').trim();
  if (!normalizedProvider || !/^\d+$/.test(normalizedCliAccountId)) return null;
  let db = null;
  try {
    db = openAppStateDatabase(fs, aiHomeDir, { ...deps, createIfMissing: false });
    if (!db) return null;
    ensureCliAccountAliasesTable(db);
    const row = db.prepare(`
      SELECT r.account_ref, r.provider, a.cli_account_id, r.created_at, r.updated_at
      FROM ${CLI_ACCOUNT_ALIASES_TABLE} a
      INNER JOIN account_refs r ON r.account_ref = a.account_ref
      WHERE a.provider = ? AND a.cli_account_id = ?
      ORDER BY a.updated_at DESC, a.created_at DESC
      LIMIT 1
    `).get(normalizedProvider, normalizedCliAccountId);
    return mapCliAccountRefRow(row);
  } catch (error) {
    if (!deps.bestEffort) throw error;
    return null;
  } finally {
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch (_error) {}
    }
  }
}

function listCliAccountRefRecords(fs, aiHomeDir, provider = '', deps = {}) {
  const normalizedProvider = provider ? normalizeProvider(provider) : '';
  if (provider && !normalizedProvider) return [];
  let db = null;
  try {
    db = openAppStateDatabase(fs, aiHomeDir, { ...deps, createIfMissing: false });
    if (!db) return [];
    ensureCliAccountAliasesTable(db);
    const rows = normalizedProvider
      ? db.prepare(`
        SELECT r.account_ref, r.provider, a.cli_account_id, r.created_at, r.updated_at
        FROM ${CLI_ACCOUNT_ALIASES_TABLE} a
        INNER JOIN account_refs r ON r.account_ref = a.account_ref
        WHERE a.provider = ?
        ORDER BY CAST(a.cli_account_id AS INTEGER), a.updated_at DESC
      `).all(normalizedProvider)
      : db.prepare(`
        SELECT r.account_ref, r.provider, a.cli_account_id, r.created_at, r.updated_at
        FROM ${CLI_ACCOUNT_ALIASES_TABLE} a
        INNER JOIN account_refs r ON r.account_ref = a.account_ref
        ORDER BY a.provider, CAST(a.cli_account_id AS INTEGER), a.updated_at DESC
      `).all();
    const seenSlots = new Set();
    return (rows || [])
      .map(mapCliAccountRefRow)
      .filter((record) => {
        if (!record) return false;
        const slot = `${record.provider}\u0000${record.cliAccountId}`;
        if (seenSlots.has(slot)) return false;
        seenSlots.add(slot);
        return true;
      });
  } catch (error) {
    if (!deps.bestEffort) throw error;
    return [];
  } finally {
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch (_error) {}
    }
  }
}

function deleteAccountRef(fs, aiHomeDir, accountRef, deps = {}) {
  const normalizedRef = String(accountRef || '').trim();
  if (!isAccountRef(normalizedRef)) return false;
  let db = null;
  try {
    db = openAppStateDatabase(fs, aiHomeDir, { ...deps, createIfMissing: false });
    if (!db) return false;
    ensureAccountRefsTable(db);
    const result = db.prepare('DELETE FROM account_refs WHERE account_ref = ?').run(normalizedRef);
    return Number(result && result.changes) > 0;
  } catch (error) {
    if (!deps.bestEffort) throw error;
    return false;
  } finally {
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch (_error) {}
    }
  }
}

module.exports = {
  ACCOUNT_REF_PREFIX,
  CLI_ACCOUNT_ALIASES_TABLE,
  deleteAccountRef,
  ensureCliAccountAliasesTable,
  ensureAccountRefsTable,
  getPublicAccountRef,
  isAccountRef,
  listAccountRefRecords,
  listCliAccountRefRecords,
  normalizeAccountRefRecord,
  resolveAccountRef,
  resolveCliAccountRef,
  resolveAccountRefByCliId,
  upsertAccountRefRecordInDatabase,
  upsertAccountRef
};
