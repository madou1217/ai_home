CREATE TABLE account_models (
  account_ref TEXT NOT NULL,
  model_id TEXT NOT NULL
    CHECK (
      length(model_id) BETWEEN 1 AND 256
      AND model_id = trim(model_id)
    ),
  upstream_available INTEGER NOT NULL DEFAULT 0
    CHECK (upstream_available IN (0, 1)),
  manual_policy TEXT NOT NULL DEFAULT 'inherit'
    CHECK (manual_policy IN ('inherit', 'force_enable', 'force_disable')),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms BETWEEN 0 AND 253402300799999),
  PRIMARY KEY (account_ref, model_id),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_account_models_effective
  ON account_models (model_id, account_ref)
  WHERE manual_policy = 'force_enable'
     OR (manual_policy = 'inherit' AND upstream_available = 1);

PRAGMA user_version = 2;
