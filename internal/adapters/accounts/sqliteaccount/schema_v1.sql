CREATE TABLE accounts (
  account_ref TEXT NOT NULL PRIMARY KEY
    CHECK (
      length(account_ref) = 25
      AND substr(account_ref, 1, 5) = 'acct_'
      AND substr(account_ref, 6) NOT GLOB '*[^0-9a-f]*'
    ),
  provider_id TEXT NOT NULL
    CHECK (
      length(provider_id) BETWEEN 1 AND 64
      AND provider_id NOT GLOB '*[^a-z0-9_-]*'
      AND substr(provider_id, 1, 1) NOT GLOB '[-_]'
      AND substr(provider_id, -1, 1) NOT GLOB '[-_]'
    ),
  cli_account_id INTEGER NOT NULL CHECK (cli_account_id > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 253402300799999),
  updated_at_ms INTEGER NOT NULL
    CHECK (
      updated_at_ms BETWEEN created_at_ms AND 253402300799999
    ),
  UNIQUE (provider_id, cli_account_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_accounts_routing
  ON accounts (provider_id, account_ref, cli_account_id)
  WHERE enabled = 1;

CREATE TABLE account_credentials (
  account_ref TEXT NOT NULL PRIMARY KEY,
  auth_kind TEXT NOT NULL
    CHECK (
      length(auth_kind) BETWEEN 1 AND 32
      AND auth_kind NOT GLOB '*[^a-z0-9_]*'
    ),
  auth_mode TEXT NOT NULL DEFAULT ''
    CHECK (
      auth_mode = ''
      OR (
        length(auth_mode) BETWEEN 1 AND 32
        AND auth_mode NOT GLOB '*[^a-z0-9_]*'
      )
    ),
  format_version INTEGER NOT NULL CHECK (format_version = 1),
  credential_json TEXT NOT NULL
    CHECK (
      json_valid(credential_json)
      AND json_type(credential_json) = 'object'
    ),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms BETWEEN 0 AND 253402300799999),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE account_profiles (
  account_ref TEXT NOT NULL PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '' CHECK (length(display_name) <= 256),
  email TEXT NOT NULL DEFAULT '' CHECK (length(email) <= 320),
  subscription_kind TEXT NOT NULL DEFAULT 'unknown'
    CHECK (
      length(subscription_kind) BETWEEN 1 AND 64
      AND subscription_kind NOT GLOB '*[^a-z0-9_]*'
    ),
  subscription_raw TEXT NOT NULL DEFAULT '' CHECK (length(subscription_raw) <= 128),
  format_version INTEGER NOT NULL CHECK (format_version = 1),
  profile_json TEXT NOT NULL
    CHECK (
      json_valid(profile_json)
      AND json_type(profile_json) = 'object'
    ),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms BETWEEN 0 AND 253402300799999),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

PRAGMA application_id = 1095321649;
PRAGMA user_version = 1;
