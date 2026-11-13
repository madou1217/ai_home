package chatruntime

const nativeSessionIDExpr = "NULLIF(TRIM(CAST(json_extract(runtime_binding_json, '$.nativeSessionId') AS TEXT)), '')"

const chatRuntimeSchemaSQL = `
  CREATE TABLE IF NOT EXISTS chat_runtime_native_thread_items (
    session_id TEXT NOT NULL REFERENCES chat_runtime_sessions(session_id) ON DELETE CASCADE,
    native_thread_id TEXT NOT NULL,
    native_turn_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    item_json TEXT NOT NULL,
    raw_message_id TEXT,
    ordinal INTEGER NOT NULL,
    PRIMARY KEY (session_id, item_id),
    UNIQUE(session_id, ordinal)
  );
  CREATE TABLE IF NOT EXISTS chat_runtime_branch_operations (
    command_id TEXT PRIMARY KEY REFERENCES chat_runtime_commands(command_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES chat_runtime_sessions(session_id) ON DELETE CASCADE,
    execution_account_ref TEXT NOT NULL,
    source_native_thread_id TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    state TEXT NOT NULL,
    native_receipt_json TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_runtime_native_history_coverage (
    session_id TEXT NOT NULL REFERENCES chat_runtime_sessions(session_id) ON DELETE CASCADE,
    native_thread_id TEXT NOT NULL,
    native_turn_id TEXT NOT NULL,
    state TEXT NOT NULL,
    PRIMARY KEY (session_id, native_thread_id, native_turn_id)
  );
  CREATE TABLE IF NOT EXISTS chat_runtime_native_response_items (
    session_id TEXT NOT NULL REFERENCES chat_runtime_sessions(session_id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    native_thread_id TEXT NOT NULL,
    native_turn_id TEXT NOT NULL DEFAULT '',
    ordinal INTEGER,
    response_item_json TEXT NOT NULL,
    PRIMARY KEY (session_id, item_id)
  );

  CREATE TABLE IF NOT EXISTS chat_runtime_history_seeds (
    session_id TEXT PRIMARY KEY REFERENCES chat_runtime_sessions(session_id) ON DELETE CASCADE,
    response_items_json TEXT NOT NULL,
    message_submissions_json TEXT NOT NULL,
    regeneration_json TEXT NOT NULL
  );
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
  CREATE TABLE IF NOT EXISTS chat_runtime_migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_runtime_native_session
    ON chat_runtime_sessions(
      provider,
      ` + nativeSessionIDExpr + `
    )
    WHERE ` + nativeSessionIDExpr + ` IS NOT NULL;
`
