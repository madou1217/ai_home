CREATE TABLE account_usage_snapshots (
  account_ref TEXT NOT NULL PRIMARY KEY,
  provider_id TEXT NOT NULL
    CHECK (
      length(provider_id) BETWEEN 1 AND 128
      AND provider_id NOT GLOB '*[^a-z0-9_.:-]*'
    ),
  kind TEXT NOT NULL DEFAULT ''
    CHECK (
      length(kind) <= 128
      AND kind NOT GLOB '*[^a-z0-9_.:-]*'
    ),
  source TEXT NOT NULL DEFAULT ''
    CHECK (
      length(source) <= 128
      AND source NOT GLOB '*[^a-z0-9_.:-]*'
    ),
  captured_at_ms INTEGER NOT NULL
    CHECK (captured_at_ms BETWEEN 0 AND 253402300799999),
  payload_json TEXT NOT NULL
    CHECK (
      length(payload_json) BETWEEN 2 AND 262144
      AND json_valid(payload_json)
      AND json_type(payload_json) = 'object'
    ),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_account_usage_snapshots_provider
  ON account_usage_snapshots(provider_id, account_ref);

PRAGMA user_version = 11;
