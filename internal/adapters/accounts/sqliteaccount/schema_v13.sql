CREATE TABLE account_ui_state (
  account_ref TEXT NOT NULL PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'up'
    CHECK (length(status) BETWEEN 1 AND 32),
  display_name TEXT NOT NULL DEFAULT ''
    CHECK (length(display_name) <= 256),
  auth_mode TEXT NOT NULL DEFAULT ''
    CHECK (length(auth_mode) <= 64),
  api_key_mode INTEGER NOT NULL DEFAULT 0
    CHECK (api_key_mode IN (0, 1)),
  base_url TEXT NOT NULL DEFAULT ''
    CHECK (length(base_url) <= 2048),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms BETWEEN 0 AND 253402300799999),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

PRAGMA user_version = 13;
