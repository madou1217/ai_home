'use strict';

const crypto = require('node:crypto');
const {
  ensureExactTableSchema,
  openAppStateDatabase
} = require('../server/app-state-store');
const { ensureAccountRefsTable, isAccountRef } = require('../server/account-ref-store');

const DETECTOR_STATE_TABLE = 'account_quota_detector_state';
const RESET_EVENTS_TABLE = 'account_quota_reset_events';

const DETECTOR_STATE_COLUMNS = Object.freeze([
  'account_ref',
  'provider',
  'quota_key',
  'last_remaining_pct',
  'last_expected_reset_at_ms',
  'last_captured_at_ms',
  'is_armed',
  'rearm_generation',
  'exhausted_at_ms',
  'updated_at_ms'
]);

const RESET_EVENT_COLUMNS = Object.freeze([
  'id',
  'event_key',
  'account_ref',
  'provider',
  'quota_key',
  'window_label',
  'window_minutes',
  'event_kind',
  'classification',
  'cause',
  'previous_remaining_pct',
  'current_remaining_pct',
  'previous_expected_reset_at_ms',
  'detected_at_ms',
  'early_duration_ms',
  'exhausted_at_ms',
  'occurred_at_ms'
]);

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function optionalInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function optionalFloat(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function createDetectorStateTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${DETECTOR_STATE_TABLE} (
      account_ref TEXT NOT NULL,
      provider TEXT NOT NULL,
      quota_key TEXT NOT NULL,
      last_remaining_pct REAL,
      last_expected_reset_at_ms INTEGER,
      last_captured_at_ms INTEGER NOT NULL,
      is_armed INTEGER DEFAULT 0,
      rearm_generation INTEGER DEFAULT 0,
      exhausted_at_ms INTEGER,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (account_ref, quota_key),
      FOREIGN KEY (account_ref) REFERENCES account_refs(account_ref) ON DELETE CASCADE
    )
  `);
}

function createResetEventsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${RESET_EVENTS_TABLE} (
      id INTEGER PRIMARY KEY,
      event_key TEXT NOT NULL UNIQUE,
      account_ref TEXT NOT NULL,
      provider TEXT NOT NULL,
      quota_key TEXT NOT NULL,
      window_label TEXT,
      window_minutes INTEGER,
      event_kind TEXT NOT NULL,
      classification TEXT NOT NULL,
      cause TEXT DEFAULT 'unknown',
      previous_remaining_pct REAL,
      current_remaining_pct REAL,
      previous_expected_reset_at_ms INTEGER,
      detected_at_ms INTEGER NOT NULL,
      early_duration_ms INTEGER DEFAULT 0,
      exhausted_at_ms INTEGER,
      occurred_at_ms INTEGER NOT NULL,
      FOREIGN KEY (account_ref) REFERENCES account_refs(account_ref) ON DELETE CASCADE
    )
  `);
}

function ensureQuotaResetTables(db) {
  ensureAccountRefsTable(db);
  // Auto-migrate columns and rebuild index if needed
  try {
    const detectorCols = (db.prepare(`PRAGMA table_info(${DETECTOR_STATE_TABLE})`).all() || []).map(r => r.name);
    if (detectorCols.length > 0 && !detectorCols.includes('exhausted_at_ms')) {
      db.exec(`ALTER TABLE ${DETECTOR_STATE_TABLE} ADD COLUMN exhausted_at_ms INTEGER`);
    }
    const eventCols = (db.prepare(`PRAGMA table_info(${RESET_EVENTS_TABLE})`).all() || []).map(r => r.name);
    if (eventCols.length > 0 && !eventCols.includes('exhausted_at_ms')) {
      db.exec(`ALTER TABLE ${RESET_EVENTS_TABLE} ADD COLUMN exhausted_at_ms INTEGER`);
    }
    if (eventCols.length > 0 && !eventCols.includes('occurred_at_ms')) {
      db.exec(`ALTER TABLE ${RESET_EVENTS_TABLE} ADD COLUMN occurred_at_ms INTEGER DEFAULT 0`);
      db.exec(`UPDATE ${RESET_EVENTS_TABLE} SET occurred_at_ms = detected_at_ms WHERE occurred_at_ms = 0 OR occurred_at_ms IS NULL`);
    }
  } catch (_migrationErr) {}

  ensureExactTableSchema(db, {
    tableName: DETECTOR_STATE_TABLE,
    columns: DETECTOR_STATE_COLUMNS,
    primaryKey: ['account_ref', 'quota_key'],
    create: () => createDetectorStateTable(db),
    errorCode: 'quota_detector_state_schema_invalid'
  });
  ensureExactTableSchema(db, {
    tableName: RESET_EVENTS_TABLE,
    columns: RESET_EVENT_COLUMNS,
    primaryKey: ['id'],
    create: () => createResetEventsTable(db),
    errorCode: 'quota_reset_events_schema_invalid'
  });
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_quota_reset_events_account_time
      ON ${RESET_EVENTS_TABLE} (account_ref, occurred_at_ms DESC, id DESC)
  `);
}

function withDatabase(fs, aiHomeDir, callback, options = {}) {
  let db = null;
  try {
    db = openAppStateDatabase(fs, aiHomeDir, {
      createIfMissing: options.createIfMissing !== false
    });
    if (!db) return null;
    ensureQuotaResetTables(db);
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

function mapEventRow(row) {
  if (!row) return null;
  const detectedAtMs = Number(row.detected_at_ms) || 0;
  const occurredAtMs = Number(row.occurred_at_ms) || detectedAtMs;
  return {
    id: Number(row.id),
    eventKey: text(row.event_key),
    accountRef: text(row.account_ref),
    provider: text(row.provider),
    quotaKey: text(row.quota_key),
    windowLabel: text(row.window_label),
    windowMinutes: optionalInteger(row.window_minutes),
    eventKind: text(row.event_kind),
    classification: text(row.classification),
    cause: text(row.cause),
    previousRemainingPct: optionalFloat(row.previous_remaining_pct),
    currentRemainingPct: optionalFloat(row.current_remaining_pct),
    previousExpectedResetAtMs: optionalInteger(row.previous_expected_reset_at_ms),
    exhaustedAtMs: optionalInteger(row.exhausted_at_ms),
    occurredAtMs,
    detectedAtMs,
    earlyDurationMs: Number(row.early_duration_ms) || 0
  };
}

function mapDetectorStateRow(row) {
  if (!row) return null;
  return {
    accountRef: text(row.account_ref),
    provider: text(row.provider),
    quotaKey: text(row.quota_key),
    lastRemainingPct: optionalFloat(row.last_remaining_pct),
    lastExpectedResetAtMs: optionalInteger(row.last_expected_reset_at_ms),
    lastCapturedAtMs: Number(row.last_captured_at_ms) || 0,
    isArmed: Boolean(row.is_armed),
    rearmGeneration: Number(row.rearm_generation) || 0,
    exhaustedAtMs: optionalInteger(row.exhausted_at_ms),
    updatedAtMs: Number(row.updated_at_ms) || 0
  };
}

function getDetectorState(db, accountRef, quotaKey) {
  const row = db.prepare(`
    SELECT ${DETECTOR_STATE_COLUMNS.join(', ')}
    FROM ${DETECTOR_STATE_TABLE}
    WHERE account_ref = ? AND quota_key = ?
  `).get(accountRef, quotaKey);
  return mapDetectorStateRow(row);
}

function upsertDetectorState(db, state) {
  db.prepare(`
    INSERT INTO ${DETECTOR_STATE_TABLE} (
      account_ref, provider, quota_key, last_remaining_pct,
      last_expected_reset_at_ms, last_captured_at_ms, is_armed,
      rearm_generation, exhausted_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (account_ref, quota_key) DO UPDATE SET
      provider = excluded.provider,
      last_remaining_pct = excluded.last_remaining_pct,
      last_expected_reset_at_ms = excluded.last_expected_reset_at_ms,
      last_captured_at_ms = excluded.last_captured_at_ms,
      is_armed = excluded.is_armed,
      rearm_generation = excluded.rearm_generation,
      exhausted_at_ms = excluded.exhausted_at_ms,
      updated_at_ms = excluded.updated_at_ms
  `).run(
    state.accountRef,
    state.provider,
    state.quotaKey,
    state.lastRemainingPct,
    state.lastExpectedResetAtMs,
    state.lastCapturedAtMs,
    state.isArmed ? 1 : 0,
    state.rearmGeneration || 0,
    state.exhaustedAtMs || null,
    state.updatedAtMs
  );
}

function insertResetEvent(db, event) {
  const detectedAtMs = Number(event.detectedAtMs) || Date.now();
  const occurredAtMs = Number(event.occurredAtMs) || detectedAtMs;
  return db.prepare(`
    INSERT INTO ${RESET_EVENTS_TABLE} (
      event_key, account_ref, provider, quota_key, window_label,
      window_minutes, event_kind, classification, cause,
      previous_remaining_pct, current_remaining_pct,
      previous_expected_reset_at_ms, detected_at_ms, early_duration_ms, exhausted_at_ms, occurred_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (event_key) DO NOTHING
  `).run(
    event.eventKey,
    event.accountRef,
    event.provider,
    event.quotaKey,
    event.windowLabel,
    event.windowMinutes,
    event.eventKind,
    event.classification,
    event.cause || 'unknown',
    event.previousRemainingPct,
    event.currentRemainingPct,
    event.previousExpectedResetAtMs,
    detectedAtMs,
    event.earlyDurationMs || 0,
    event.exhaustedAtMs || null,
    occurredAtMs
  );
}

function listAccountQuotaResetEvents(fs, aiHomeDir, accountRef, options = {}) {
  const normalizedRef = text(accountRef);
  if (!isAccountRef(normalizedRef)) return [];
  const limit = Math.max(1, Math.min(200, Number(options.limit) || 50));
  const beforeId = optionalInteger(options.beforeId);
  const beforeOccurredAtMs = optionalInteger(options.beforeOccurredAtMs);

  return withDatabase(fs, aiHomeDir, (db) => {
    let sql = `
      SELECT ${RESET_EVENT_COLUMNS.join(', ')}
      FROM ${RESET_EVENTS_TABLE}
      WHERE account_ref = ?
    `;
    const params = [normalizedRef];
    if (beforeOccurredAtMs != null && beforeId != null) {
      sql += ' AND (occurred_at_ms < ? OR (occurred_at_ms = ? AND id < ?)) ';
      params.push(beforeOccurredAtMs, beforeOccurredAtMs, beforeId);
    } else if (beforeId != null && beforeId > 0) {
      sql += ' AND id < ? ';
      params.push(beforeId);
    }
    sql += ' ORDER BY occurred_at_ms DESC, id DESC LIMIT ? ';
    params.push(limit);

    const rows = db.prepare(sql).all(...params) || [];
    return rows.map(mapEventRow).filter(Boolean);
  }, { createIfMissing: false }) || [];
}

module.exports = {
  DETECTOR_STATE_TABLE,
  RESET_EVENTS_TABLE,
  ensureQuotaResetTables,
  withDatabase,
  withImmediateTransaction,
  getDetectorState,
  upsertDetectorState,
  insertResetEvent,
  listAccountQuotaResetEvents
};
