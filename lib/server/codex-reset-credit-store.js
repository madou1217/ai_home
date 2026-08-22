'use strict';

const {
  ensureExactTableSchema,
  openAppStateDatabase
} = require('./app-state-store');
const { ensureAccountRefsTable, isAccountRef } = require('./account-ref-store');

const RESET_CREDITS_TABLE = 'codex_reset_credits';
const RESET_OPERATIONS_TABLE = 'codex_reset_operations';
const RESET_CREDIT_COLUMNS = Object.freeze([
  'account_ref',
  'credit_id',
  'status',
  'granted_at',
  'expires_at',
  'first_seen_at',
  'last_seen_at',
  'consumed_at',
  'consumed_operation_id',
  'status_source'
]);
const RESET_OPERATION_COLUMNS = Object.freeze([
  'operation_id',
  'account_ref',
  'credit_id',
  'inventory_version',
  'status',
  'outcome',
  'requested_at',
  'updated_at',
  'completed_at',
  'before_count',
  'after_count',
  'error_code'
]);
const ACTIVE_OPERATION_STATUSES = new Set(['consuming', 'unknown']);

function codedError(code, message, statusCode) {
  const error = new Error(message || code);
  error.code = code;
  if (statusCode) error.statusCode = statusCode;
  return error;
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function optionalInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function requireAccountRef(accountRef) {
  const normalized = text(accountRef);
  if (!isAccountRef(normalized)) throw codedError('invalid_account_ref', '', 400);
  return normalized;
}

function createResetCreditsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${RESET_CREDITS_TABLE} (
      account_ref TEXT NOT NULL,
      credit_id TEXT NOT NULL,
      status TEXT NOT NULL,
      granted_at INTEGER,
      expires_at INTEGER,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      consumed_at INTEGER,
      consumed_operation_id TEXT,
      status_source TEXT NOT NULL,
      PRIMARY KEY(account_ref, credit_id),
      FOREIGN KEY(account_ref) REFERENCES account_refs(account_ref) ON DELETE CASCADE
    )
  `);
}

function createResetOperationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${RESET_OPERATIONS_TABLE} (
      operation_id TEXT PRIMARY KEY,
      account_ref TEXT NOT NULL,
      credit_id TEXT NOT NULL,
      inventory_version TEXT NOT NULL,
      status TEXT NOT NULL,
      outcome TEXT,
      requested_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      before_count INTEGER NOT NULL,
      after_count INTEGER,
      error_code TEXT,
      FOREIGN KEY(account_ref) REFERENCES account_refs(account_ref) ON DELETE CASCADE
    )
  `);
}

function ensureResetCreditTables(db) {
  ensureAccountRefsTable(db);
  ensureExactTableSchema(db, {
    tableName: RESET_CREDITS_TABLE,
    columns: RESET_CREDIT_COLUMNS,
    primaryKey: ['account_ref', 'credit_id'],
    create: () => createResetCreditsTable(db),
    errorCode: 'codex_reset_credit_schema_invalid'
  });
  ensureExactTableSchema(db, {
    tableName: RESET_OPERATIONS_TABLE,
    columns: RESET_OPERATION_COLUMNS,
    primaryKey: ['operation_id'],
    create: () => createResetOperationsTable(db),
    errorCode: 'codex_reset_operation_schema_invalid'
  });
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_codex_reset_credits_account_status_expiry
      ON ${RESET_CREDITS_TABLE}(account_ref, status, expires_at)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_codex_reset_operations_account_requested
      ON ${RESET_OPERATIONS_TABLE}(account_ref, requested_at DESC)
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_reset_operations_account_active
      ON ${RESET_OPERATIONS_TABLE}(account_ref)
      WHERE status IN ('consuming', 'unknown')
  `);
}

function withDatabase(fs, aiHomeDir, callback, options = {}) {
  let db = null;
  try {
    db = openAppStateDatabase(fs, aiHomeDir, {
      createIfMissing: options.createIfMissing !== false
    });
    if (!db) return null;
    ensureResetCreditTables(db);
    return callback(db);
  } finally {
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch (_error) {}
    }
  }
}

function withImmediateTransaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) {}
    throw error;
  }
}

function mapCreditRow(row) {
  if (!row) return null;
  return {
    accountRef: text(row.account_ref),
    creditId: text(row.credit_id),
    status: text(row.status),
    grantedAt: optionalInteger(row.granted_at),
    expiresAt: optionalInteger(row.expires_at),
    firstSeenAt: Number(row.first_seen_at) || 0,
    lastSeenAt: Number(row.last_seen_at) || 0,
    consumedAt: optionalInteger(row.consumed_at),
    consumedOperationId: text(row.consumed_operation_id),
    statusSource: text(row.status_source)
  };
}

function mapOperationRow(row) {
  if (!row) return null;
  return {
    operationId: text(row.operation_id),
    accountRef: text(row.account_ref),
    creditId: text(row.credit_id),
    inventoryVersion: text(row.inventory_version),
    status: text(row.status),
    outcome: text(row.outcome),
    requestedAt: Number(row.requested_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    completedAt: optionalInteger(row.completed_at),
    beforeCount: Number(row.before_count) || 0,
    afterCount: optionalInteger(row.after_count),
    errorCode: text(row.error_code)
  };
}

function deriveExpiredCredits(db, accountRef, now) {
  db.prepare(`
    UPDATE ${RESET_CREDITS_TABLE}
    SET status = 'expired', status_source = 'derived'
    WHERE account_ref = ?
      AND status IN ('available', 'missing')
      AND expires_at IS NOT NULL
      AND expires_at <= ?
  `).run(accountRef, now);
}

function syncResetCreditInventory(fs, aiHomeDir, accountRef, inventory = {}, options = {}) {
  const normalizedRef = requireAccountRef(accountRef);
  const now = Number(options.now) || Date.now();
  const credits = Array.isArray(inventory.credits) ? inventory.credits : [];
  return withDatabase(fs, aiHomeDir, (db) => withImmediateTransaction(db, () => {
    const seen = new Set();
    const readExisting = db.prepare(`
      SELECT status, consumed_at, consumed_operation_id
      FROM ${RESET_CREDITS_TABLE}
      WHERE account_ref = ? AND credit_id = ?
    `);
    const upsert = db.prepare(`
      INSERT INTO ${RESET_CREDITS_TABLE} (
        account_ref, credit_id, status, granted_at, expires_at,
        first_seen_at, last_seen_at, consumed_at, consumed_operation_id, status_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_ref, credit_id) DO UPDATE SET
        status = excluded.status,
        granted_at = COALESCE(excluded.granted_at, ${RESET_CREDITS_TABLE}.granted_at),
        expires_at = COALESCE(excluded.expires_at, ${RESET_CREDITS_TABLE}.expires_at),
        last_seen_at = excluded.last_seen_at,
        consumed_at = excluded.consumed_at,
        consumed_operation_id = excluded.consumed_operation_id,
        status_source = excluded.status_source
    `);
    for (const credit of credits) {
      const creditId = text(credit && credit.creditId);
      if (!creditId || seen.has(creditId)) continue;
      seen.add(creditId);
      const existing = readExisting.get(normalizedRef, creditId);
      const protectedStatus = existing && ['consuming', 'consumed', 'unknown'].includes(text(existing.status));
      const status = protectedStatus ? text(existing.status) : text(credit.status) || 'unknown';
      const source = protectedStatus ? 'local' : 'upstream';
      upsert.run(
        normalizedRef,
        creditId,
        status,
        optionalInteger(credit.grantedAt),
        optionalInteger(credit.expiresAt),
        now,
        now,
        optionalInteger(existing && existing.consumed_at),
        existing && existing.consumed_operation_id ? text(existing.consumed_operation_id) : null,
        source
      );
    }

    if (inventory.detailsComplete === true) {
      const activeRows = db.prepare(`
        SELECT credit_id
        FROM ${RESET_CREDITS_TABLE}
        WHERE account_ref = ? AND status = 'available'
      `).all(normalizedRef) || [];
      const markMissing = db.prepare(`
        UPDATE ${RESET_CREDITS_TABLE}
        SET status = 'missing', status_source = 'reconciled'
        WHERE account_ref = ? AND credit_id = ? AND status = 'available'
      `);
      for (const row of activeRows) {
        const creditId = text(row.credit_id);
        if (!seen.has(creditId)) markMissing.run(normalizedRef, creditId);
      }
    }
    deriveExpiredCredits(db, normalizedRef, now);
    return true;
  }));
}

function listResetCreditHistory(fs, aiHomeDir, accountRef, options = {}) {
  const normalizedRef = requireAccountRef(accountRef);
  const now = Number(options.now) || Date.now();
  return withDatabase(fs, aiHomeDir, (db) => withImmediateTransaction(db, () => {
    deriveExpiredCredits(db, normalizedRef, now);
    return (db.prepare(`
      SELECT ${RESET_CREDIT_COLUMNS.join(', ')}
      FROM ${RESET_CREDITS_TABLE}
      WHERE account_ref = ?
      ORDER BY expires_at IS NULL, expires_at, granted_at, credit_id
    `).all(normalizedRef) || []).map(mapCreditRow).filter(Boolean);
  }), { createIfMissing: false }) || [];
}

function getResetCreditOperation(fs, aiHomeDir, operationId) {
  const normalizedId = text(operationId);
  if (!normalizedId) return null;
  return withDatabase(fs, aiHomeDir, (db) => mapOperationRow(db.prepare(`
    SELECT ${RESET_OPERATION_COLUMNS.join(', ')}
    FROM ${RESET_OPERATIONS_TABLE}
    WHERE operation_id = ?
  `).get(normalizedId)), { createIfMissing: false });
}

function getActiveResetCreditOperation(fs, aiHomeDir, accountRef) {
  const normalizedRef = requireAccountRef(accountRef);
  return withDatabase(fs, aiHomeDir, (db) => mapOperationRow(db.prepare(`
    SELECT ${RESET_OPERATION_COLUMNS.join(', ')}
    FROM ${RESET_OPERATIONS_TABLE}
    WHERE account_ref = ? AND status IN ('consuming', 'unknown')
    ORDER BY requested_at DESC
    LIMIT 1
  `).get(normalizedRef)), { createIfMissing: false });
}

function reserveResetCreditOperation(fs, aiHomeDir, input = {}) {
  const operationId = text(input.operationId);
  const accountRef = requireAccountRef(input.accountRef);
  const creditId = text(input.creditId);
  const inventoryVersion = text(input.inventoryVersion);
  if (!operationId || !creditId || !inventoryVersion) {
    throw codedError('codex_reset_operation_invalid', '', 400);
  }
  const now = Number(input.now) || Date.now();
  const beforeCount = Math.max(0, Number(input.beforeCount) || 0);
  return withDatabase(fs, aiHomeDir, (db) => withImmediateTransaction(db, () => {
    const existing = mapOperationRow(db.prepare(`
      SELECT ${RESET_OPERATION_COLUMNS.join(', ')}
      FROM ${RESET_OPERATIONS_TABLE}
      WHERE operation_id = ?
    `).get(operationId));
    if (existing) {
      if (
        existing.accountRef !== accountRef
        || existing.creditId !== creditId
        || existing.inventoryVersion !== inventoryVersion
      ) {
        throw codedError('codex_reset_idempotency_conflict', '', 409);
      }
      return { created: false, operation: existing };
    }

    const active = mapOperationRow(db.prepare(`
      SELECT ${RESET_OPERATION_COLUMNS.join(', ')}
      FROM ${RESET_OPERATIONS_TABLE}
      WHERE account_ref = ? AND status IN ('consuming', 'unknown')
      ORDER BY requested_at DESC
      LIMIT 1
    `).get(accountRef));
    if (active) {
      throw codedError(
        active.status === 'unknown'
          ? 'codex_reset_operation_unknown'
          : 'codex_reset_operation_in_progress',
        '',
        409
      );
    }

    const credit = db.prepare(`
      SELECT status
      FROM ${RESET_CREDITS_TABLE}
      WHERE account_ref = ? AND credit_id = ?
    `).get(accountRef, creditId);
    if (!credit || text(credit.status) !== 'available') {
      throw codedError('codex_reset_credit_unavailable', '', 409);
    }

    db.prepare(`
      INSERT INTO ${RESET_OPERATIONS_TABLE} (
        operation_id, account_ref, credit_id, inventory_version, status, outcome,
        requested_at, updated_at, completed_at, before_count, after_count, error_code
      ) VALUES (?, ?, ?, ?, 'consuming', NULL, ?, ?, NULL, ?, NULL, NULL)
    `).run(operationId, accountRef, creditId, inventoryVersion, now, now, beforeCount);
    db.prepare(`
      UPDATE ${RESET_CREDITS_TABLE}
      SET status = 'consuming', consumed_operation_id = ?, status_source = 'local'
      WHERE account_ref = ? AND credit_id = ?
    `).run(operationId, accountRef, creditId);
    return {
      created: true,
      operation: getOperationInDatabase(db, operationId)
    };
  }));
}

function getOperationInDatabase(db, operationId) {
  return mapOperationRow(db.prepare(`
    SELECT ${RESET_OPERATION_COLUMNS.join(', ')}
    FROM ${RESET_OPERATIONS_TABLE}
    WHERE operation_id = ?
  `).get(operationId));
}

function markResetCreditOperationUnknown(fs, aiHomeDir, input = {}) {
  const operationId = text(input.operationId);
  if (!operationId) throw codedError('codex_reset_operation_invalid', '', 400);
  const now = Number(input.now) || Date.now();
  return withDatabase(fs, aiHomeDir, (db) => withImmediateTransaction(db, () => {
    const operation = getOperationInDatabase(db, operationId);
    if (!operation) throw codedError('codex_reset_operation_not_found', '', 404);
    if (!ACTIVE_OPERATION_STATUSES.has(operation.status)) return operation;
    db.prepare(`
      UPDATE ${RESET_OPERATIONS_TABLE}
      SET status = 'unknown', updated_at = ?, error_code = ?
      WHERE operation_id = ?
    `).run(now, text(input.errorCode) || 'codex_reset_result_unknown', operationId);
    db.prepare(`
      UPDATE ${RESET_CREDITS_TABLE}
      SET status = 'unknown', status_source = 'local'
      WHERE account_ref = ? AND credit_id = ?
    `).run(operation.accountRef, operation.creditId);
    return getOperationInDatabase(db, operationId);
  }));
}

function completeResetCreditOperation(fs, aiHomeDir, input = {}) {
  const operationId = text(input.operationId);
  const outcome = text(input.outcome);
  if (!operationId || !outcome) throw codedError('codex_reset_operation_invalid', '', 400);
  const now = Number(input.now) || Date.now();
  const afterCount = optionalInteger(input.afterCount);
  return withDatabase(fs, aiHomeDir, (db) => withImmediateTransaction(db, () => {
    const operation = getOperationInDatabase(db, operationId);
    if (!operation) throw codedError('codex_reset_operation_not_found', '', 404);
    if (!ACTIVE_OPERATION_STATUSES.has(operation.status)) return operation;
    const consumed = outcome === 'reset' || outcome === 'alreadyRedeemed';
    const operationStatus = consumed ? 'succeeded' : 'no_effect';
    db.prepare(`
      UPDATE ${RESET_OPERATIONS_TABLE}
      SET status = ?, outcome = ?, updated_at = ?, completed_at = ?, after_count = ?, error_code = NULL
      WHERE operation_id = ?
    `).run(operationStatus, outcome, now, now, afterCount, operationId);
    if (consumed) {
      db.prepare(`
        UPDATE ${RESET_CREDITS_TABLE}
        SET status = 'consumed', consumed_at = ?, consumed_operation_id = ?, status_source = 'local'
        WHERE account_ref = ? AND credit_id = ?
      `).run(now, operationId, operation.accountRef, operation.creditId);
    } else {
      db.prepare(`
        UPDATE ${RESET_CREDITS_TABLE}
        SET status = ?, consumed_operation_id = NULL, status_source = 'reconciled'
        WHERE account_ref = ? AND credit_id = ?
      `).run(
        outcome === 'noCredit' ? 'missing' : 'available',
        operation.accountRef,
        operation.creditId
      );
    }
    return getOperationInDatabase(db, operationId);
  }));
}

module.exports = {
  RESET_CREDITS_TABLE,
  RESET_OPERATIONS_TABLE,
  completeResetCreditOperation,
  ensureResetCreditTables,
  getActiveResetCreditOperation,
  getResetCreditOperation,
  listResetCreditHistory,
  markResetCreditOperationUnknown,
  reserveResetCreditOperation,
  syncResetCreditInventory
};
