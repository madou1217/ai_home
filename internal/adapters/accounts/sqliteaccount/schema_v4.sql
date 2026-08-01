CREATE TABLE account_credentials_v4 (
  account_ref TEXT NOT NULL PRIMARY KEY,
  credential_ref TEXT NOT NULL
    CHECK (
      length(credential_ref) = 25
      AND substr(credential_ref, 1, 5) = 'cred_'
      AND substr(credential_ref, 6) NOT GLOB '*[^0-9a-f]*'
    ),
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

INSERT INTO account_credentials_v4 (
  account_ref,
  credential_ref,
  auth_kind,
  auth_mode,
  format_version,
  credential_json,
  updated_at_ms
)
SELECT
  account_ref,
  'cred_' || substr(account_ref, 6),
  auth_kind,
  auth_mode,
  format_version,
  credential_json,
  updated_at_ms
FROM account_credentials;

DROP TABLE account_credentials;
ALTER TABLE account_credentials_v4 RENAME TO account_credentials;

CREATE UNIQUE INDEX idx_account_credentials_credential_ref
  ON account_credentials (credential_ref);

PRAGMA user_version = 4;
