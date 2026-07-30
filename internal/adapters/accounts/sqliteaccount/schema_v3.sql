CREATE TABLE account_usage (
  account_ref TEXT NOT NULL,
  limit_id TEXT NOT NULL DEFAULT ''
    CHECK (
      limit_id = ''
      OR (
        length(limit_id) BETWEEN 1 AND 128
        AND limit_id NOT GLOB '*[^a-z0-9_.:-]*'
      )
    ),
  limit_name TEXT NOT NULL DEFAULT ''
    CHECK (
      length(limit_name) <= 256
      AND limit_name = trim(limit_name)
    ),
  bucket TEXT NOT NULL
    CHECK (
      length(bucket) BETWEEN 1 AND 128
      AND bucket NOT GLOB '*[^a-z0-9_.:-]*'
    ),
  kind TEXT NOT NULL CHECK (kind IN ('window', 'credits')),
  scope TEXT NOT NULL CHECK (scope IN ('account', 'model_family')),
  scope_key TEXT NOT NULL DEFAULT ''
    CHECK (
      (scope = 'account' AND scope_key = '')
      OR (
        scope = 'model_family'
        AND length(scope_key) BETWEEN 1 AND 128
        AND scope_key NOT GLOB '*[^a-z0-9_.:-]*'
      )
    ),
  remaining_bps INTEGER
    CHECK (remaining_bps IS NULL OR remaining_bps BETWEEN 0 AND 10000),
  availability TEXT NOT NULL
    CHECK (
      availability IN (
        'unknown',
        'available',
        'exhausted',
        'unlimited',
        'disabled'
      )
      AND (
        remaining_bps IS NULL
        OR (remaining_bps = 0 AND availability = 'exhausted')
        OR (remaining_bps > 0 AND availability = 'available')
      )
      AND (
        kind = 'credits'
        OR availability IN ('unknown', 'available', 'exhausted')
      )
    ),
  window_seconds INTEGER
    CHECK (window_seconds IS NULL OR window_seconds BETWEEN 1 AND 316224000),
  reset_at_ms INTEGER
    CHECK (reset_at_ms IS NULL OR reset_at_ms BETWEEN 0 AND 253402300799999),
  source TEXT NOT NULL
    CHECK (
      length(source) BETWEEN 1 AND 128
      AND source NOT GLOB '*[^a-z0-9_.:-]*'
    ),
  captured_at_ms INTEGER NOT NULL
    CHECK (captured_at_ms BETWEEN 0 AND 253402300799999),
  PRIMARY KEY (account_ref, limit_id, bucket),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

PRAGMA user_version = 3;
