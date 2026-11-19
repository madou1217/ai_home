-- SchemaV32: materialized session index for the WebUI session list.
-- All rows live in aih.db; no second database is introduced.
CREATE TABLE IF NOT EXISTS session_index (
  provider TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  project_path TEXT NOT NULL,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms >= 0 AND updated_at_ms <= 253402300799999),
  project_dir_name TEXT NOT NULL,
  scanned_at_ms INTEGER NOT NULL
    CHECK (scanned_at_ms >= 0 AND scanned_at_ms <= 253402300799999),
  PRIMARY KEY (provider, account_ref, project_id, session_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_session_index_scope
  ON session_index (provider, account_ref, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS session_index_state (
  provider TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  scanned_at_ms INTEGER NOT NULL
    CHECK (scanned_at_ms >= 0 AND scanned_at_ms <= 253402300799999),
  truncated INTEGER NOT NULL
    CHECK (truncated IN (0, 1)),
  PRIMARY KEY (provider, account_ref)
) STRICT;

PRAGMA user_version = 32;
