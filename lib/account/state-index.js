'use strict';

const {
  ensureExactTableSchema,
  getAppStateDbPath,
  openAppStateDatabase
} = require('../server/app-state-store');
const { ensureAccountRefsTable, isAccountRef } = require('../server/account-ref-store');
const {
  deriveRuntimeStatus,
  isBlockingRuntimeStatus
} = require('./runtime-view');

const SQLITE_BUSY_ERRCODE = 5;
const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const DEFAULT_BUSY_RETRY_MS = 25;
const ACCOUNT_STATE_COLUMNS = Object.freeze([
  'account_ref',
  'provider',
  'status',
  'configured',
  'api_key_mode',
  'auth_mode',
  'runtime_state',
  'remaining_pct',
  'display_name',
  'updated_at'
]);

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
  Atomics.wait(new Int32Array(sab), 0, 0, waitMs);
}

function runWithBusyRetry(fn, retryWindowMs = DEFAULT_BUSY_TIMEOUT_MS) {
  const deadline = Date.now() + Math.max(0, Number(retryWindowMs) || DEFAULT_BUSY_TIMEOUT_MS);
  for (;;) {
    try {
      return fn();
    } catch (error) {
      if (!isSqliteBusyError(error) || Date.now() >= deadline) throw error;
      sleepSync(DEFAULT_BUSY_RETRY_MS);
    }
  }
}

function normalizeAccountRef(accountRef) {
  const value = String(accountRef || '').trim();
  return isAccountRef(value) ? value : '';
}

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function normalizeStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (value === 'down' || value === 'disabled') return 'down';
  if (value === 'up' || value === 'enabled') return 'up';
  return null;
}

function normalizeRemainingPct(value) {
  if (value == null || value === '') return null;
  const remainingPct = Number(value);
  if (!Number.isFinite(remainingPct)) return null;
  return Math.max(0, Math.min(100, remainingPct));
}

function parseRuntimeState(rawValue) {
  if (rawValue == null || rawValue === '') return null;
  try {
    const parsed = JSON.parse(String(rawValue));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function createAccountStateTable(db, tableName = 'account_state') {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      account_ref TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'up',
      configured INTEGER NOT NULL DEFAULT 0,
      api_key_mode INTEGER NOT NULL DEFAULT 0,
      auth_mode TEXT,
      runtime_state TEXT,
      remaining_pct REAL,
      display_name TEXT,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(account_ref) REFERENCES account_refs(account_ref) ON DELETE CASCADE
    )
  `);
}

function ensureAccountStateSchema(db) {
  ensureAccountRefsTable(db);
  ensureExactTableSchema(db, {
    tableName: 'account_state',
    columns: ACCOUNT_STATE_COLUMNS,
    primaryKey: ['account_ref'],
    create: () => createAccountStateTable(db),
    errorCode: 'account_state_schema_invalid'
  });
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_account_state_provider_active
      ON account_state(provider, configured, api_key_mode, remaining_pct, account_ref);
    CREATE INDEX IF NOT EXISTS idx_account_state_provider_updated
      ON account_state(provider, updated_at, account_ref);
  `);
}

function mapStateRow(row) {
  if (!row) return null;
  const values = {
    accountRef: normalizeAccountRef(row.account_ref),
    provider: normalizeProvider(row.provider),
    status: normalizeStatus(row.status) || 'up',
    configured: Number(row.configured) === 1,
    apiKeyMode: Number(row.api_key_mode) === 1,
    authMode: String(row.auth_mode || '').trim(),
    runtimeState: parseRuntimeState(row.runtime_state),
    remainingPct: normalizeRemainingPct(row.remaining_pct),
    displayName: String(row.display_name || '').trim(),
    updatedAt: Number(row.updated_at) || 0
  };
  if (!values.accountRef) return null;
  return values;
}

function createAccountStateIndex(options = {}) {
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  if (!aiHomeDir) throw new Error('account_state_index_missing_ai_home_dir');
  const fs = options.fs;
  if (!fs || typeof fs.mkdirSync !== 'function') throw new Error('account_state_index_missing_fs');

  const dbFile = getAppStateDbPath(aiHomeDir);
  const databaseOptions = options.DatabaseSync === undefined
    ? {}
    : { DatabaseSync: options.DatabaseSync };
  const db = openAppStateDatabase(fs, aiHomeDir, databaseOptions);
  if (!db) throw new Error('account_state_index_database_unavailable');
  try {
    ensureAccountStateSchema(db);
  } catch (error) {
    try { db.close(); } catch (_closeError) {}
    throw error;
  }

  const upsertStmt = db.prepare(`
    INSERT INTO account_state (
      account_ref, provider, status, configured, api_key_mode,
      auth_mode, remaining_pct, display_name, updated_at
    ) VALUES (?, ?, COALESCE(?, 'up'), ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_ref) DO UPDATE SET
      provider = excluded.provider,
      status = CASE WHEN ? IS NULL THEN account_state.status ELSE excluded.status END,
      configured = excluded.configured,
      api_key_mode = excluded.api_key_mode,
      auth_mode = COALESCE(excluded.auth_mode, account_state.auth_mode),
      remaining_pct = excluded.remaining_pct,
      display_name = COALESCE(excluded.display_name, account_state.display_name),
      updated_at = excluded.updated_at
  `);
  const upsertRuntimeStmt = db.prepare(`
    INSERT INTO account_state (
      account_ref, provider, status, configured, api_key_mode,
      auth_mode, runtime_state, display_name, updated_at
    ) VALUES (?, ?, COALESCE(?, 'up'), ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_ref) DO UPDATE SET
      provider = excluded.provider,
      status = CASE WHEN ? IS NULL THEN account_state.status ELSE excluded.status END,
      configured = excluded.configured,
      api_key_mode = excluded.api_key_mode,
      auth_mode = COALESCE(excluded.auth_mode, account_state.auth_mode),
      runtime_state = excluded.runtime_state,
      display_name = COALESCE(excluded.display_name, account_state.display_name),
      updated_at = excluded.updated_at
  `);
  const listRowsStmt = db.prepare(`
    SELECT * FROM account_state WHERE provider = ? ORDER BY updated_at DESC, account_ref
  `);
  const getStmt = db.prepare('SELECT * FROM account_state WHERE account_ref = ? LIMIT 1');
  const deleteStmt = db.prepare('DELETE FROM account_state WHERE account_ref = ?');

  function upsertAccountState(accountRef, provider, state = {}) {
    const ref = normalizeAccountRef(accountRef);
    const p = normalizeProvider(provider);
    if (!ref || !p) return false;
    const normalizedStatus = normalizeStatus(state.status);
    try {
      runWithBusyRetry(() => upsertStmt.run(
        ref,
        p,
        normalizedStatus,
        state.configured ? 1 : 0,
        state.apiKeyMode ? 1 : 0,
        state.authMode == null ? null : String(state.authMode || '').trim().slice(0, 64) || null,
        normalizeRemainingPct(state.remainingPct),
        state.displayName == null ? null : String(state.displayName || '').trim().slice(0, 255),
        Date.now(),
        normalizedStatus
      ));
      return true;
    } catch (error) {
      if (isSqliteBusyError(error)) return false;
      throw error;
    }
  }

  function setStatus(accountRef, status) {
    const ref = normalizeAccountRef(accountRef);
    const normalizedStatus = normalizeStatus(status);
    if (!ref || !normalizedStatus) return false;
    try {
      const result = runWithBusyRetry(() => db.prepare(`
        UPDATE account_state SET status = ?, updated_at = ? WHERE account_ref = ?
      `).run(normalizedStatus, Date.now(), ref));
      return Number(result && result.changes) > 0;
    } catch (error) {
      if (isSqliteBusyError(error)) return false;
      throw error;
    }
  }

  function upsertRuntimeState(accountRef, provider, runtimeState = null, baseState = {}) {
    const ref = normalizeAccountRef(accountRef);
    const p = normalizeProvider(provider);
    if (!ref || !p) return false;
    const normalizedStatus = normalizeStatus(baseState.status);
    try {
      runWithBusyRetry(() => upsertRuntimeStmt.run(
        ref,
        p,
        normalizedStatus,
        baseState.configured ? 1 : 0,
        baseState.apiKeyMode ? 1 : 0,
        baseState.authMode == null ? null : String(baseState.authMode || '').trim().slice(0, 64) || null,
        runtimeState == null ? null : JSON.stringify(runtimeState),
        baseState.displayName == null ? null : String(baseState.displayName || '').trim().slice(0, 255),
        Date.now(),
        normalizedStatus
      ));
      return true;
    } catch (error) {
      if (isSqliteBusyError(error)) return false;
      throw error;
    }
  }

  function listStates(provider) {
    const p = normalizeProvider(provider);
    if (!p) return [];
    return (listRowsStmt.all(p) || []).map((row) => mapStateRow(row)).filter(Boolean);
  }

  function listAccountRefs(provider) {
    return listStates(provider)
      .map((row) => row.accountRef)
      .sort((left, right) => left.localeCompare(right));
  }

  function listUsageCandidateRefs(provider) {
    return listStates(provider)
      .filter((row) => row.configured && row.status === 'up' && !row.apiKeyMode)
      .sort((left, right) => {
        const remainingDelta = (Number(right.remainingPct) || -1) - (Number(left.remainingPct) || -1);
        return remainingDelta || left.accountRef.localeCompare(right.accountRef);
      })
      .map((row) => row.accountRef);
  }

  function listConfiguredRefs(provider) {
    return listStates(provider)
      .filter((row) => row.configured && row.status === 'up')
      .map((row) => row.accountRef);
  }

  function listStaleRefs(provider, staleBeforeTs, limit = 200) {
    const before = Number(staleBeforeTs);
    if (!Number.isFinite(before)) return [];
    return listStates(provider)
      .filter((row) => row.updatedAt <= before)
      .sort((left, right) => left.updatedAt - right.updatedAt
        || left.accountRef.localeCompare(right.accountRef))
      .slice(0, Math.max(1, Math.min(5000, Number(limit) || 200)))
      .map((row) => row.accountRef);
  }

  function getNextCandidateRef(provider, excludedRef = '') {
    const excluded = normalizeAccountRef(excludedRef);
    const candidates = listStates(provider)
      .filter((row) => row.configured && row.status === 'up' && !row.apiKeyMode)
      .filter((row) => row.accountRef !== excluded)
      .filter((row) => !isBlockingRuntimeStatus(deriveRuntimeStatus(row)))
      .sort((left, right) => {
        const remainingDelta = (Number(right.remainingPct) || -1) - (Number(left.remainingPct) || -1);
        return remainingDelta || left.accountRef.localeCompare(right.accountRef);
      });
    return candidates.length > 0 ? candidates[0].accountRef : null;
  }

  function getAccountState(accountRef) {
    return mapStateRow(getStmt.get(normalizeAccountRef(accountRef)));
  }

  function deleteAccountState(accountRef) {
    const ref = normalizeAccountRef(accountRef);
    if (!ref) return false;
    try {
      const result = runWithBusyRetry(() => deleteStmt.run(ref));
      return Number(result && result.changes) > 0;
    } catch (error) {
      if (isSqliteBusyError(error)) return false;
      throw error;
    }
  }

  function pruneMissingRefs(provider, existingRefs) {
    const existing = new Set((Array.isArray(existingRefs) ? existingRefs : [])
      .map(normalizeAccountRef)
      .filter(Boolean));
    let removed = 0;
    listAccountRefs(provider).forEach((accountRef) => {
      if (existing.has(accountRef)) return;
      if (deleteAccountState(accountRef)) removed += 1;
    });
    return removed;
  }

  return {
    dbFile,
    upsertAccountState,
    upsertRuntimeState,
    setStatus,
    listAccountRefs,
    listStates,
    listConfiguredRefs,
    listUsageCandidateRefs,
    listStaleRefs,
    pruneMissingRefs,
    deleteAccountState,
    getAccountState,
    removeAccount: deleteAccountState,
    getNextCandidateRef,
    countByProvider(provider) {
      return listAccountRefs(provider).length;
    },
    close() {
      db.close();
    }
  };
}

module.exports = {
  createAccountStateIndex
};
