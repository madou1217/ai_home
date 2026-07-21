'use strict';

const { openAppStateDatabase } = require('../app-state-store');
const { ChatRuntimeError } = require('./contracts');

const NATIVE_SESSION_ID_EXPRESSION = `NULLIF(TRIM(CAST(json_extract(
  runtime_binding_json, '$.nativeSessionId'
) AS TEXT)), '')`;

const CHAT_RUNTIME_SCHEMA = `
  CREATE TABLE IF NOT EXISTS chat_runtime_sessions (
    session_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    execution_account_ref TEXT NOT NULL,
    project_path TEXT NOT NULL,
    state TEXT NOT NULL,
    runtime_binding_json TEXT NOT NULL,
    capability_snapshot_json TEXT NOT NULL,
    policy_json TEXT NOT NULL,
    active_turn_json TEXT,
    last_event_seq INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_runtime_commands (
    command_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES chat_runtime_sessions(session_id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    result_json TEXT,
    accepted_seq INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_runtime_attachments (
    attachment_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES chat_runtime_sessions(session_id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_runtime_queue (
    queue_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES chat_runtime_sessions(session_id) ON DELETE CASCADE,
    command_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    policy TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL,
    lease_id TEXT,
    boundary_item_id TEXT,
    result_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(session_id, position)
  );

  CREATE TABLE IF NOT EXISTS chat_runtime_interactions (
    interaction_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES chat_runtime_sessions(session_id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    revision INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL,
    resolution_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_runtime_events (
    event_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES chat_runtime_sessions(session_id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    schema TEXT NOT NULL,
    type TEXT NOT NULL,
    at INTEGER NOT NULL,
    turn_id TEXT,
    run_id TEXT,
    item_id TEXT,
    source_json TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    UNIQUE(session_id, seq)
  );

  CREATE INDEX IF NOT EXISTS idx_chat_runtime_queue_fifo
    ON chat_runtime_queue(session_id, state, position);
  CREATE INDEX IF NOT EXISTS idx_chat_runtime_interactions_pending
    ON chat_runtime_interactions(session_id, state);
  CREATE INDEX IF NOT EXISTS idx_chat_runtime_events_replay
    ON chat_runtime_events(session_id, seq);
  CREATE INDEX IF NOT EXISTS idx_chat_runtime_attachments_session
    ON chat_runtime_attachments(session_id, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_runtime_native_session
    ON chat_runtime_sessions(
      provider,
      ${NATIVE_SESSION_ID_EXPRESSION}
    )
    WHERE ${NATIVE_SESSION_ID_EXPRESSION} IS NOT NULL;
`;

function openChatRuntimeDatabase(options) {
  const databaseOptions = options.DatabaseSync === undefined
    ? {}
    : { DatabaseSync: options.DatabaseSync };
  const db = openAppStateDatabase(options.fs, options.aiHomeDir, databaseOptions);
  if (!db) throw new ChatRuntimeError('chat_runtime_database_unavailable', 503);
  withTransaction(db, () => {
    if (migrateSessionCredentialColumn(db)) detachDuplicateNativeBindings(db);
    db.exec(CHAT_RUNTIME_SCHEMA);
  });
  return db;
}

function migrateSessionCredentialColumn(db) {
  const columns = db.prepare('PRAGMA table_info(chat_runtime_sessions)').all()
    .map((column) => String(column.name || ''));
  if (!columns.includes('account_ref') || columns.includes('execution_account_ref')) return false;
  db.exec(`
    DROP INDEX IF EXISTS idx_chat_runtime_native_session;
    ALTER TABLE chat_runtime_sessions
      RENAME COLUMN account_ref TO execution_account_ref;
  `);
  return true;
}

function detachDuplicateNativeBindings(db) {
  const table = db.prepare(`
    SELECT 1 AS present FROM sqlite_master
    WHERE type = 'table' AND name = 'chat_runtime_sessions'
  `).get();
  if (!table) return;
  db.exec(`
    DROP INDEX IF EXISTS idx_chat_runtime_native_session;
    WITH ranked AS (
      SELECT
        session_id,
        ROW_NUMBER() OVER (
          PARTITION BY provider, ${NATIVE_SESSION_ID_EXPRESSION}
          ORDER BY updated_at DESC, created_at DESC, session_id DESC
        ) AS native_identity_rank
      FROM chat_runtime_sessions
      WHERE ${NATIVE_SESSION_ID_EXPRESSION} IS NOT NULL
    )
    UPDATE chat_runtime_sessions
    SET runtime_binding_json = json_remove(runtime_binding_json, '$.nativeSessionId'),
        state = 'closed',
        active_turn_json = NULL
    WHERE session_id IN (
      SELECT session_id FROM ranked WHERE native_identity_rank > 1
    );
  `);
}

function withTransaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_rollbackError) {}
    throw error;
  }
}

module.exports = {
  CHAT_RUNTIME_SCHEMA,
  openChatRuntimeDatabase,
  withTransaction
};
