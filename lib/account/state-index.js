'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const SQLITE_BUSY_ERRCODE = 5;
const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const DEFAULT_BUSY_RETRY_MS = 25;

function isSqliteBusyError(error) {
  if (!error || typeof error !== 'object') return false;
  if (Number(error.errcode) === SQLITE_BUSY_ERRCODE) return true;
  const message = String(error.message || '').toLowerCase();
  const errstr = String(error.errstr || '').toLowerCase();
  return message.includes('database is locked') || errstr.includes('database is locked');
}

function sleepSync(ms) {
  const waitMs = Math.max(1, Number(ms) || 1);
  const sab = new SharedArrayBuffer(4);
  const arr = new Int32Array(sab);
  Atomics.wait(arr, 0, 0, waitMs);
}

function runWithBusyRetry(fn, retryWindowMs = DEFAULT_BUSY_TIMEOUT_MS) {
  const deadline = Date.now() + Math.max(0, Number(retryWindowMs) || DEFAULT_BUSY_TIMEOUT_MS);
  for (;;) {
    try {
      return fn();
    } catch (error) {
      if (!isSqliteBusyError(error)) throw error;
      if (Date.now() >= deadline) throw error;
      sleepSync(DEFAULT_BUSY_RETRY_MS);
    }
  }
}

function normalizeId(id) {
  const s = String(id || '').trim();
  return /^\d+$/.test(s) ? s : '';
}

function normalizeStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (value === 'down' || value === 'disabled') return 'down';
  if (value === 'up' || value === 'enabled') return 'up';
  return null;
}

function listTableColumns(db, tableName) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() || [];
    return rows.map((row) => String(row && row.name || '').trim()).filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function ensureAccountStateTableShape(db) {
  const columns = new Set(listTableColumns(db, 'account_state'));
  if (columns.size === 0) return;
  if (!columns.has('display_name')) {
    try {
      db.exec('ALTER TABLE account_state ADD COLUMN display_name TEXT');
    } catch (_error) {}
  }
  if (!columns.has('auth_mode')) {
    try {
      db.exec('ALTER TABLE account_state ADD COLUMN auth_mode TEXT');
    } catch (_error) {}
  }
  if (!columns.has('runtime_state')) {
    try {
      db.exec('ALTER TABLE account_state ADD COLUMN runtime_state TEXT');
    } catch (_error) {}
  }
  const refreshedColumns = new Set(listTableColumns(db, 'account_state'));
  if (!refreshedColumns.has('exhausted')) return;
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE account_state_next (
      provider TEXT NOT NULL,
      account_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'up',
      configured INTEGER NOT NULL DEFAULT 0,
      api_key_mode INTEGER NOT NULL DEFAULT 0,
      auth_mode TEXT,
      runtime_state TEXT,
      remaining_pct REAL,
      display_name TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(provider, account_id)
    );
    INSERT INTO account_state_next (
      provider, account_id, status, configured, api_key_mode, auth_mode, runtime_state, remaining_pct, display_name, updated_at
    )
    SELECT
      provider,
      account_id,
      COALESCE(status, 'up'),
      configured,
      api_key_mode,
      auth_mode,
      runtime_state,
      remaining_pct,
      display_name,
      updated_at
    FROM account_state;
    DROP TABLE account_state;
    ALTER TABLE account_state_next RENAME TO account_state;
    CREATE INDEX idx_account_state_provider_active
      ON account_state(provider, configured, api_key_mode, remaining_pct, account_id);
    CREATE INDEX idx_account_state_provider_updated
      ON account_state(provider, updated_at, account_id);
    COMMIT;
  `);
}

function createAccountStateIndex(options = {}) {
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  if (!aiHomeDir) {
    throw new Error('account_state_index_missing_ai_home_dir');
  }
  const fs = options.fs;
  if (!fs || typeof fs.mkdirSync !== 'function') {
    throw new Error('account_state_index_missing_fs');
  }

  const dbFile = String(options.dbFile || '').trim() || path.join(aiHomeDir, 'account_state.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS};`);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS account_state (
      provider TEXT NOT NULL,
      account_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'up',
      configured INTEGER NOT NULL DEFAULT 0,
      api_key_mode INTEGER NOT NULL DEFAULT 0,
      auth_mode TEXT,
      runtime_state TEXT,
      remaining_pct REAL,
      display_name TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(provider, account_id)
    );
    CREATE INDEX IF NOT EXISTS idx_account_state_provider_active
      ON account_state(provider, configured, api_key_mode, remaining_pct, account_id);
    CREATE INDEX IF NOT EXISTS idx_account_state_provider_updated
      ON account_state(provider, updated_at, account_id);
  `);
  try {
    db.exec("ALTER TABLE account_state ADD COLUMN status TEXT NOT NULL DEFAULT 'up'");
  } catch (_e) {}
  ensureAccountStateTableShape(db);

  const upsertStmt = db.prepare(`
    INSERT INTO account_state (
      provider, account_id, status, configured, api_key_mode, auth_mode, remaining_pct, display_name, updated_at
    ) VALUES (?, ?, COALESCE(?, 'up'), ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, account_id) DO UPDATE SET
      status = CASE
        WHEN ? IS NULL THEN account_state.status
        ELSE excluded.status
      END,
      configured = excluded.configured,
      api_key_mode = excluded.api_key_mode,
      auth_mode = COALESCE(excluded.auth_mode, account_state.auth_mode),
      remaining_pct = excluded.remaining_pct,
      display_name = COALESCE(excluded.display_name, account_state.display_name),
      updated_at = excluded.updated_at
  `);

  const setStatusStmt = db.prepare(`
    UPDATE account_state
    SET status = ?, updated_at = ?
    WHERE provider = ? AND account_id = ?
  `);

  const upsertRuntimeStateStmt = db.prepare(`
    INSERT INTO account_state (
      provider, account_id, status, configured, api_key_mode, auth_mode, runtime_state, remaining_pct, display_name, updated_at
    ) VALUES (?, ?, COALESCE(?, 'up'), ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, account_id) DO UPDATE SET
      status = CASE
        WHEN ? IS NULL THEN account_state.status
        ELSE excluded.status
      END,
      configured = COALESCE(excluded.configured, account_state.configured),
      api_key_mode = COALESCE(excluded.api_key_mode, account_state.api_key_mode),
      auth_mode = COALESCE(excluded.auth_mode, account_state.auth_mode),
      runtime_state = excluded.runtime_state,
      display_name = COALESCE(excluded.display_name, account_state.display_name),
      updated_at = excluded.updated_at
  `);

  const listIdsStmt = db.prepare(`
    SELECT account_id
    FROM account_state
    WHERE provider = ?
    ORDER BY CAST(account_id AS INTEGER) ASC
  `);

  const nextCandidateStmt = db.prepare(`
    SELECT account_id
    FROM account_state
    WHERE provider = ?
      AND configured = 1
      AND status = 'up'
      AND api_key_mode = 0
      AND account_id <> ?
    ORDER BY COALESCE(remaining_pct, -1.0) DESC, CAST(account_id AS INTEGER) ASC
    LIMIT 1
  `);

  const providerCountStmt = db.prepare(`
    SELECT COUNT(*) AS c
    FROM account_state
    WHERE provider = ?
  `);

  const listRowsStmt = db.prepare(`
    SELECT provider, account_id, status, configured, api_key_mode, auth_mode, runtime_state, remaining_pct, display_name, updated_at
    FROM account_state
    WHERE provider = ?
    ORDER BY CAST(account_id AS INTEGER) ASC
  `);

  const listUsageCandidatesStmt = db.prepare(`
    SELECT account_id
    FROM account_state
    WHERE provider = ?
      AND configured = 1
      AND status = 'up'
      AND api_key_mode = 0
    ORDER BY COALESCE(remaining_pct, -1.0) DESC, CAST(account_id AS INTEGER) ASC
  `);

  const listConfiguredStmt = db.prepare(`
    SELECT account_id
    FROM account_state
    WHERE provider = ?
      AND configured = 1
      AND status = 'up'
    ORDER BY CAST(account_id AS INTEGER) ASC
  `);

  const listStaleStmt = db.prepare(`
    SELECT account_id
    FROM account_state
    WHERE provider = ?
      AND updated_at <= ?
    ORDER BY updated_at ASC, CAST(account_id AS INTEGER) ASC
    LIMIT ?
  `);

  const deleteMissingStmt = db.prepare(`
    DELETE FROM account_state
    WHERE provider = ? AND account_id = ?
  `);

  const getAccountStateStmt = db.prepare(`
    SELECT provider, account_id, status, configured, api_key_mode, auth_mode, runtime_state, remaining_pct, display_name, updated_at
    FROM account_state
    WHERE provider = ? AND account_id = ?
    LIMIT 1
  `);

  function parseRuntimeState(rawValue) {
    if (rawValue == null || rawValue === '') return null;
    try {
      const parsed = JSON.parse(String(rawValue));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  function upsertAccountState(provider, accountId, state = {}) {
    const p = String(provider || '').trim();
    const id = normalizeId(accountId);
    if (!p || !id) return false;
    const configured = state.configured ? 1 : 0;
    const normalizedStatus = normalizeStatus(state.status);
    const apiKeyMode = state.apiKeyMode ? 1 : 0;
    const authMode = state.authMode == null
      ? null
      : String(state.authMode || '').trim().slice(0, 64) || null;
    const remainingPct = Number(state.remainingPct);
    const normalizedRemaining = Number.isFinite(remainingPct)
      ? Math.max(0, Math.min(100, remainingPct))
      : null;
    const displayName = state.displayName == null
      ? null
      : String(state.displayName || '').trim().slice(0, 255);
    try {
      runWithBusyRetry(() => upsertStmt.run(
        p,
        id,
        normalizedStatus,
        configured,
        apiKeyMode,
        authMode,
        normalizedRemaining,
        displayName,
        Date.now(),
        normalizedStatus
      ));
    } catch (error) {
      if (isSqliteBusyError(error)) return false;
      throw error;
    }
    return true;
  }

  function setStatus(provider, accountId, status) {
    const p = String(provider || '').trim();
    const id = normalizeId(accountId);
    const normalizedStatus = normalizeStatus(status);
    if (!p || !id || !normalizedStatus) return false;
    let result = null;
    try {
      result = runWithBusyRetry(() => setStatusStmt.run(normalizedStatus, Date.now(), p, id));
    } catch (error) {
      if (isSqliteBusyError(error)) return false;
      throw error;
    }
    return Number(result && result.changes) > 0;
  }

  function upsertRuntimeState(provider, accountId, runtimeState = null, baseState = {}) {
    const p = String(provider || '').trim();
    const id = normalizeId(accountId);
    if (!p || !id) return false;
    const normalizedStatus = normalizeStatus(baseState.status);
    const configured = baseState.configured ? 1 : 0;
    const apiKeyMode = baseState.apiKeyMode ? 1 : 0;
    const authMode = baseState.authMode == null
      ? null
      : String(baseState.authMode || '').trim().slice(0, 64) || null;
    const displayName = baseState.displayName == null
      ? null
      : String(baseState.displayName || '').trim().slice(0, 255);
    const serializedRuntimeState = runtimeState == null ? null : JSON.stringify(runtimeState);
    try {
      runWithBusyRetry(() => upsertRuntimeStateStmt.run(
        p,
        id,
        normalizedStatus,
        configured,
        apiKeyMode,
        authMode,
        serializedRuntimeState,
        null,
        displayName,
        Date.now(),
        normalizedStatus
      ));
    } catch (error) {
      if (isSqliteBusyError(error)) return false;
      throw error;
    }
    return true;
  }

  function listAccountIds(provider) {
    const p = String(provider || '').trim();
    if (!p) return [];
    const rows = listIdsStmt.all(p) || [];
    return rows
      .map((row) => normalizeId(row.account_id))
      .filter(Boolean);
  }

  function getNextCandidateId(provider, excludedId = '') {
    const p = String(provider || '').trim();
    if (!p) return null;
    const excluded = normalizeId(excludedId) || '';
    const row = nextCandidateStmt.get(p, excluded);
    if (!row) return null;
    const id = normalizeId(row.account_id);
    return id || null;
  }

  function countByProvider(provider) {
    const p = String(provider || '').trim();
    if (!p) return 0;
    const row = providerCountStmt.get(p);
    return Number(row && row.c) || 0;
  }

  function listStates(provider) {
    const p = String(provider || '').trim();
    if (!p) return [];
    const rows = listRowsStmt.all(p) || [];
    return rows.map((row) => ({
      provider: String(row.provider || ''),
      accountId: normalizeId(row.account_id),
      status: normalizeStatus(row.status) || 'up',
      configured: Number(row.configured) === 1,
      apiKeyMode: Number(row.api_key_mode) === 1,
      authMode: String(row.auth_mode || '').trim(),
      runtimeState: parseRuntimeState(row.runtime_state),
      remainingPct: Number.isFinite(Number(row.remaining_pct)) ? Number(row.remaining_pct) : null,
      displayName: String(row.display_name || '').trim(),
      updatedAt: Number(row.updated_at) || 0
    })).filter((row) => !!row.accountId);
  }

  function listUsageCandidateIds(provider) {
    const p = String(provider || '').trim();
    if (!p) return [];
    const rows = listUsageCandidatesStmt.all(p) || [];
    return rows.map((row) => normalizeId(row.account_id)).filter(Boolean);
  }

  function listConfiguredIds(provider) {
    const p = String(provider || '').trim();
    if (!p) return [];
    const rows = listConfiguredStmt.all(p) || [];
    return rows.map((row) => normalizeId(row.account_id)).filter(Boolean);
  }

  function listStaleIds(provider, staleBeforeTs, limit = 200) {
    const p = String(provider || '').trim();
    if (!p) return [];
    const before = Number(staleBeforeTs);
    if (!Number.isFinite(before)) return [];
    const cappedLimit = Math.max(1, Math.min(5000, Number(limit) || 200));
    const rows = listStaleStmt.all(p, Math.floor(before), cappedLimit) || [];
    return rows.map((row) => normalizeId(row.account_id)).filter(Boolean);
  }

  function pruneMissingIds(provider, existingIds) {
    const p = String(provider || '').trim();
    if (!p) return 0;
    const existing = new Set((Array.isArray(existingIds) ? existingIds : []).map((x) => normalizeId(x)).filter(Boolean));
    const rows = listIdsStmt.all(p) || [];
    let removed = 0;
    rows.forEach((row) => {
      const id = normalizeId(row.account_id);
      if (!id || existing.has(id)) return;
      let result = null;
      try {
        result = runWithBusyRetry(() => deleteMissingStmt.run(p, id));
      } catch (error) {
        if (isSqliteBusyError(error)) return;
        throw error;
      }
      if (Number(result && result.changes) > 0) removed += 1;
    });
    return removed;
  }

  function deleteAccountState(provider, accountId) {
    const p = String(provider || '').trim();
    const id = normalizeId(accountId);
    if (!p || !id) return false;
    let result = null;
    try {
      result = runWithBusyRetry(() => deleteMissingStmt.run(p, id));
    } catch (error) {
      if (isSqliteBusyError(error)) return false;
      throw error;
    }
    return Number(result && result.changes) > 0;
  }

  function getAccountState(provider, accountId) {
    const p = String(provider || '').trim();
    const id = normalizeId(accountId);
    if (!p || !id) return null;
    const row = getAccountStateStmt.get(p, id);
    if (!row) return null;
    return {
      provider: String(row.provider || ''),
      account_id: normalizeId(row.account_id),
      status: normalizeStatus(row.status) || 'up',
      configured: Number(row.configured) === 1,
      api_key_mode: Number(row.api_key_mode) === 1,
      auth_mode: String(row.auth_mode || '').trim(),
      runtime_state: parseRuntimeState(row.runtime_state),
      remaining_pct: Number.isFinite(Number(row.remaining_pct)) ? Number(row.remaining_pct) : null,
      display_name: String(row.display_name || '').trim(),
      updated_at: Number(row.updated_at) || 0
    };
  }

  function removeAccount(provider, accountId) {
    return deleteAccountState(provider, accountId);
  }

  return {
    dbFile,
    upsertAccountState,
    upsertRuntimeState,
    setStatus,
    listAccountIds,
    listStates,
    listConfiguredIds,
    listUsageCandidateIds,
    listStaleIds,
    pruneMissingIds,
    deleteAccountState,
    getAccountState,
    removeAccount,
    getNextCandidateId,
    countByProvider
  };
}

module.exports = {
  createAccountStateIndex
};
