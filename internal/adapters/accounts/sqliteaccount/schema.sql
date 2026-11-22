-- 账号数据库（aih.db）无版本基线表结构。
--
-- 新建库与兼容引导直接建立完整终态列集合；既有库通过 IF NOT EXISTS 跳过已存在表，
-- 缺失列再由 Go 按 PRAGMA table_info 增量补齐，不使用结构版本号门禁。

CREATE TABLE IF NOT EXISTS accounts (
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

CREATE TABLE IF NOT EXISTS account_credentials (
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

CREATE TABLE IF NOT EXISTS account_profiles (
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
  workspace_id TEXT NOT NULL DEFAULT ''
    CHECK (length(workspace_id) <= 256),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS account_models (
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

CREATE TABLE IF NOT EXISTS account_usage (
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
  plan_type TEXT NOT NULL DEFAULT ''
    CHECK (length(plan_type) <= 64),
  PRIMARY KEY (account_ref, limit_id, bucket),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS account_defaults (
  provider_id TEXT NOT NULL PRIMARY KEY
    CHECK (
      length(provider_id) BETWEEN 1 AND 64
      AND provider_id NOT GLOB '*[^a-z0-9_-]*'
      AND substr(provider_id, 1, 1) NOT GLOB '[-_]'
      AND substr(provider_id, -1, 1) NOT GLOB '[-_]'
    ),
  account_ref TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms BETWEEN 0 AND 253402300799999),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS account_outcomes (
  account_ref TEXT NOT NULL,
  granularity TEXT NOT NULL CHECK (granularity IN ('day', 'hour')),
  bucket_start_ms INTEGER NOT NULL CHECK (bucket_start_ms >= 0),
  outcome TEXT NOT NULL
    CHECK (length(outcome) BETWEEN 1 AND 64 AND outcome NOT GLOB '*[^a-z_]*'),
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (account_ref, granularity, bucket_start_ms, outcome),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS account_runtime_state (
  account_ref TEXT NOT NULL,
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 256),
  streak_kind TEXT NOT NULL DEFAULT ''
    CHECK (streak_kind = '' OR streak_kind NOT GLOB '*[^a-z_]*'),
  streak_count INTEGER NOT NULL DEFAULT 0 CHECK (streak_count BETWEEN 0 AND 255),
  streak_expires_at_ms INTEGER NOT NULL DEFAULT 0
    CHECK (streak_expires_at_ms BETWEEN 0 AND 253402300799999),
  cooldown_kind TEXT NOT NULL DEFAULT ''
    CHECK (cooldown_kind = '' OR cooldown_kind NOT GLOB '*[^a-z_]*'),
  cooldown_until_ms INTEGER NOT NULL DEFAULT 0
    CHECK (cooldown_until_ms BETWEEN 0 AND 253402300799999),
  last_failure_at_ms INTEGER NOT NULL DEFAULT 0
    CHECK (last_failure_at_ms BETWEEN 0 AND 253402300799999),
  CHECK (streak_kind <> '' OR (streak_count = 0 AND streak_expires_at_ms = 0)),
  CHECK (streak_kind = '' OR (streak_count >= 1 AND streak_expires_at_ms >= 1)),
  CHECK (cooldown_kind <> '' OR cooldown_until_ms = 0),
  CHECK (cooldown_kind = '' OR cooldown_until_ms >= 1),
  PRIMARY KEY (account_ref, model_id),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS usage_ledger (
  usage_id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_ref TEXT NOT NULL,
  provider_id TEXT NOT NULL
    CHECK (length(provider_id) BETWEEN 1 AND 64
      AND provider_id NOT GLOB '*[^a-z0-9_-]*'),
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 256),
  session_id TEXT NOT NULL DEFAULT '' CHECK (length(session_id) <= 256),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms BETWEEN 0 AND 253402300799999),
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  cached_input_tokens INTEGER NOT NULL CHECK (cached_input_tokens >= 0),
  cache_write_input_tokens INTEGER NOT NULL CHECK (cache_write_input_tokens >= 0),
  reasoning_tokens INTEGER NOT NULL CHECK (reasoning_tokens >= 0),
  total_tokens INTEGER NOT NULL CHECK (total_tokens >= 1),
  source_key TEXT NOT NULL DEFAULT '',
  quota_bucket TEXT NOT NULL DEFAULT '',
  CHECK (cached_input_tokens + cache_write_input_tokens <= input_tokens),
  CHECK (reasoning_tokens <= output_tokens),
  CHECK (total_tokens = input_tokens + output_tokens),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS account_tombstones (
  tombstone_key TEXT NOT NULL PRIMARY KEY
    CHECK (length(tombstone_key) BETWEEN 1 AND 256),
  account_ref TEXT NOT NULL
    CHECK (
      length(account_ref) = 25
      AND substr(account_ref, 1, 5) = 'acct_'
      AND substr(account_ref, 6) NOT GLOB '*[^0-9a-f]*'
    ),
  provider_id TEXT NOT NULL
    CHECK (
      length(provider_id) BETWEEN 1 AND 64
      AND provider_id NOT GLOB '*[^a-z0-9_-]*'
    ),
  kind TEXT NOT NULL
    CHECK (kind IN ('account', 'api_key')),
  fingerprint TEXT NOT NULL DEFAULT ''
    CHECK (fingerprint = '' OR fingerprint GLOB '[0-9a-f]*'),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 253402300799999)
) STRICT;

CREATE TABLE IF NOT EXISTS account_usage_snapshots (
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
  quota_status TEXT NOT NULL DEFAULT ''
    CHECK (
      quota_status IN ('', 'available', 'exhausted', 'pending', 'not_applicable')
    ),
  quota_reason TEXT NOT NULL DEFAULT ''
    CHECK (length(quota_reason) <= 128),
  remaining_bps INTEGER
    CHECK (remaining_bps IS NULL OR remaining_bps BETWEEN 0 AND 10000),
  has_numeric_remaining INTEGER NOT NULL DEFAULT 0
    CHECK (has_numeric_remaining IN (0, 1)),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS account_ui_state (
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
  configured INTEGER NOT NULL DEFAULT 0
    CHECK (configured IN (0, 1)),
  oauth_pending INTEGER NOT NULL DEFAULT 0
    CHECK (oauth_pending IN (0, 1)),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS account_runtime_blocks (
  account_ref TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (length(kind) BETWEEN 1 AND 64),
  scope TEXT NOT NULL
    CHECK (scope IN ('account', 'account_model')),
  reason TEXT NOT NULL DEFAULT ''
    CHECK (length(reason) <= 500),
  observed_at_ms INTEGER NOT NULL
    CHECK (observed_at_ms BETWEEN 0 AND 253402300799999),
  until_ms INTEGER NOT NULL
    CHECK (until_ms BETWEEN 0 AND 253402300799999),
  PRIMARY KEY (account_ref, kind),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS account_runtime_states (
  account_ref TEXT NOT NULL PRIMARY KEY
    CHECK (
      length(account_ref) = 25
      AND substr(account_ref, 1, 5) = 'acct_'
      AND substr(account_ref, 6) NOT GLOB '*[^0-9a-f]*'
    ),
  state_json TEXT NOT NULL
    CHECK (length(state_json) BETWEEN 2 AND 65536),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms BETWEEN 0 AND 253402300799999),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS oauth_jobs (
  job_id TEXT PRIMARY KEY
    CHECK (length(job_id) BETWEEN 1 AND 128),
  provider_id TEXT NOT NULL
    CHECK (length(provider_id) BETWEEN 1 AND 64),
  purpose TEXT NOT NULL
    CHECK (length(purpose) BETWEEN 1 AND 32),
  target_ref TEXT NOT NULL DEFAULT ''
    CHECK (length(target_ref) <= 128),
  status TEXT NOT NULL
    CHECK (length(status) BETWEEN 1 AND 32),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 253402300799999),
  expires_at_ms INTEGER NOT NULL
    CHECK (expires_at_ms BETWEEN 0 AND 253402300799999),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms BETWEEN 0 AND 253402300799999),
  error_code TEXT NOT NULL DEFAULT ''
    CHECK (length(error_code) <= 64),
  error_message TEXT NOT NULL DEFAULT '',
  account_ref TEXT NOT NULL DEFAULT ''
    CHECK (length(account_ref) <= 128),
  cli_account_id INTEGER NOT NULL DEFAULT 0
    CHECK (cli_account_id >= 0),
  finished_at_ms INTEGER NOT NULL DEFAULT 0
    CHECK (finished_at_ms BETWEEN 0 AND 253402300799999),
  owner TEXT NOT NULL DEFAULT 'go'
    CHECK (owner IN ('go', 'node')),
  source TEXT NOT NULL DEFAULT 'go'
    CHECK (source IN ('go', 'node'))
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS account_quota_window_samples (
  sample_id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_ref TEXT NOT NULL,
  provider_id TEXT NOT NULL
    CHECK (
      length(provider_id) BETWEEN 1 AND 128
      AND provider_id NOT GLOB '*[^a-z0-9_.:-]*'
    ),
  quota_key TEXT NOT NULL CHECK (length(quota_key) BETWEEN 1 AND 192),
  window_label TEXT NOT NULL DEFAULT '' CHECK (length(window_label) <= 256),
  window_minutes INTEGER NOT NULL CHECK (window_minutes > 0),
  remaining_pct REAL
    CHECK (remaining_pct IS NULL OR (remaining_pct >= 0 AND remaining_pct <= 100)),
  expected_reset_at_ms INTEGER NOT NULL
    CHECK (expected_reset_at_ms BETWEEN 0 AND 253402300799999),
  captured_at_ms INTEGER NOT NULL
    CHECK (captured_at_ms BETWEEN 0 AND 253402300799999),
  captured_bucket INTEGER NOT NULL CHECK (captured_bucket >= 0),
  plan_type TEXT NOT NULL DEFAULT '' CHECK (length(plan_type) <= 64),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 253402300799999),
  UNIQUE (account_ref, quota_key, window_minutes, captured_bucket),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS account_quota_window_ledger (
  account_ref TEXT PRIMARY KEY,
  window_minutes INTEGER NOT NULL DEFAULT 0 CHECK (window_minutes >= 0),
  anchor_at_ms INTEGER NOT NULL DEFAULT 0
    CHECK (anchor_at_ms BETWEEN 0 AND 253402300799999),
  close_at_ms INTEGER NOT NULL DEFAULT 0
    CHECK (close_at_ms BETWEEN 0 AND 253402300799999),
  source TEXT NOT NULL DEFAULT ''
    CHECK (source IN ('', 'snapshot', 'probe', 'activity')),
  observed_at_ms INTEGER NOT NULL DEFAULT 0
    CHECK (observed_at_ms BETWEEN 0 AND 253402300799999),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms BETWEEN 0 AND 253402300799999),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS account_quota_detector_state (
  account_ref TEXT NOT NULL,
  quota_key TEXT NOT NULL CHECK (length(quota_key) BETWEEN 1 AND 192),
  provider_id TEXT NOT NULL
    CHECK (
      length(provider_id) BETWEEN 1 AND 128
      AND provider_id NOT GLOB '*[^a-z0-9_.:-]*'
    ),
  last_remaining_pct REAL
    CHECK (last_remaining_pct IS NULL OR (last_remaining_pct >= 0 AND last_remaining_pct <= 100)),
  last_expected_reset_at_ms INTEGER NOT NULL DEFAULT 0
    CHECK (last_expected_reset_at_ms BETWEEN 0 AND 253402300799999),
  last_captured_at_ms INTEGER NOT NULL
    CHECK (last_captured_at_ms BETWEEN 0 AND 253402300799999),
  is_armed INTEGER NOT NULL DEFAULT 0 CHECK (is_armed IN (0, 1)),
  rearm_generation INTEGER NOT NULL DEFAULT 0 CHECK (rearm_generation >= 0),
  exhausted_at_ms INTEGER
    CHECK (exhausted_at_ms IS NULL OR exhausted_at_ms BETWEEN 0 AND 253402300799999),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms BETWEEN 0 AND 253402300799999),
  PRIMARY KEY (account_ref, quota_key),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS account_quota_reset_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE CHECK (length(event_key) = 32),
  account_ref TEXT NOT NULL,
  provider_id TEXT NOT NULL
    CHECK (
      length(provider_id) BETWEEN 1 AND 128
      AND provider_id NOT GLOB '*[^a-z0-9_.:-]*'
    ),
  quota_key TEXT NOT NULL CHECK (length(quota_key) BETWEEN 1 AND 192),
  window_label TEXT NOT NULL DEFAULT '' CHECK (length(window_label) <= 256),
  window_minutes INTEGER NOT NULL DEFAULT 0 CHECK (window_minutes >= 0),
  event_kind TEXT NOT NULL CHECK (event_kind IN ('cycle_rollover', 'replenishment')),
  classification TEXT NOT NULL DEFAULT '' CHECK (length(classification) <= 32),
  cause TEXT NOT NULL DEFAULT '' CHECK (length(cause) <= 64),
  previous_remaining_pct REAL
    CHECK (previous_remaining_pct IS NULL OR (previous_remaining_pct >= 0 AND previous_remaining_pct <= 100)),
  current_remaining_pct REAL
    CHECK (current_remaining_pct IS NULL OR (current_remaining_pct >= 0 AND current_remaining_pct <= 100)),
  previous_expected_reset_at_ms INTEGER NOT NULL DEFAULT 0
    CHECK (previous_expected_reset_at_ms BETWEEN 0 AND 253402300799999),
  exhausted_at_ms INTEGER
    CHECK (exhausted_at_ms IS NULL OR exhausted_at_ms BETWEEN 0 AND 253402300799999),
  occurred_at_ms INTEGER NOT NULL
    CHECK (occurred_at_ms BETWEEN 0 AND 253402300799999),
  detected_at_ms INTEGER NOT NULL
    CHECK (detected_at_ms BETWEEN 0 AND 253402300799999),
  early_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (early_duration_ms >= 0),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 253402300799999),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS account_model_probes (
  account_ref TEXT NOT NULL PRIMARY KEY
    CHECK (
      length(account_ref) = 25
      AND substr(account_ref, 1, 5) = 'acct_'
      AND substr(account_ref, 6) NOT GLOB '*[^0-9a-f]*'
    ),
  provider_id TEXT NOT NULL
    CHECK (length(provider_id) BETWEEN 1 AND 64),
  last_attempt_at_ms INTEGER NOT NULL
    CHECK (last_attempt_at_ms BETWEEN 0 AND 253402300799999),
  last_error_code TEXT NOT NULL DEFAULT ''
    CHECK (length(last_error_code) <= 64),
  last_error_message TEXT NOT NULL DEFAULT ''
    CHECK (length(last_error_message) <= 300),
  last_source TEXT NOT NULL DEFAULT ''
    CHECK (length(last_source) <= 16),
  last_model_count INTEGER NOT NULL DEFAULT 0
    CHECK (last_model_count BETWEEN 0 AND 1024),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms BETWEEN 0 AND 253402300799999),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS model_alias (
  id TEXT PRIMARY KEY,
  alias TEXT NOT NULL,
  target TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'all',
  target_provider TEXT NOT NULL DEFAULT 'auto',
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  description TEXT NOT NULL DEFAULT '',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  display_models_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS model_alias_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO model_alias_meta (id, generation) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS account_probe_state (
  account_ref TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  checked_at_ms INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS account_routing_exclusions (
  account_ref TEXT PRIMARY KEY,
  excluded INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  updated_at_ms INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS upstream_error_mapping_group (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT 'all',
  enabled INTEGER NOT NULL DEFAULT 1
    CHECK (enabled IN (0, 1)),
  position INTEGER NOT NULL
    CHECK (position >= 0),
  version INTEGER NOT NULL DEFAULT 1
    CHECK (version >= 1),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 253402300799999),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms BETWEEN 0 AND 253402300799999)
) STRICT;

CREATE TABLE IF NOT EXISTS upstream_error_mapping_rule (
  group_id TEXT NOT NULL,
  position INTEGER NOT NULL
    CHECK (position >= 0),
  rule_json TEXT NOT NULL,
  PRIMARY KEY (group_id, position),
  FOREIGN KEY (group_id) REFERENCES upstream_error_mapping_group(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS account_upstream_error_rule (
  account_ref TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'account'
    CHECK (source IN ('account', 'projection')),
  position INTEGER NOT NULL
    CHECK (position >= 0),
  rule_json TEXT NOT NULL,
  PRIMARY KEY (account_ref, source, position),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS account_upstream_error_group (
  account_ref TEXT NOT NULL,
  position INTEGER NOT NULL
    CHECK (position >= 0),
  group_id TEXT NOT NULL,
  PRIMARY KEY (account_ref, position),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS account_default_ownership (
  provider_id TEXT NOT NULL PRIMARY KEY,
  owner TEXT NOT NULL CHECK(owner = 'go'),
  expected_ref TEXT,
  operation_id TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

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

CREATE TABLE IF NOT EXISTS session_index_state (
  provider TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  scanned_at_ms INTEGER NOT NULL
    CHECK (scanned_at_ms >= 0 AND scanned_at_ms <= 253402300799999),
  truncated INTEGER NOT NULL
    CHECK (truncated IN (0, 1)),
  PRIMARY KEY (provider, account_ref)
) STRICT;

CREATE TABLE IF NOT EXISTS client_api_keys (
  key_id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash BLOB NOT NULL,
  key_prefix TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
    CHECK (enabled IN (0, 1)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  last_used_at_ms INTEGER NOT NULL DEFAULT 0,
  revoked_at_ms INTEGER NOT NULL DEFAULT 0,
  allowed_providers_json TEXT NOT NULL DEFAULT '[]',
  allowed_models_json TEXT NOT NULL DEFAULT '[]',
  max_concurrency INTEGER NOT NULL DEFAULT 0
    CHECK (max_concurrency >= 0),
  rpm_limit INTEGER NOT NULL DEFAULT 0
    CHECK (rpm_limit >= 0),
  tpm_limit INTEGER NOT NULL DEFAULT 0
    CHECK (tpm_limit >= 0),
  daily_token_limit INTEGER NOT NULL DEFAULT 0
    CHECK (daily_token_limit >= 0),
  notes TEXT NOT NULL DEFAULT ''
) STRICT;

CREATE TABLE IF NOT EXISTS account_concurrency_limits (
  account_ref TEXT NOT NULL,
  model_id TEXT NOT NULL DEFAULT '',
  max_concurrency INTEGER NOT NULL DEFAULT 0
    CHECK (max_concurrency >= 0),
  rpm_limit INTEGER NOT NULL DEFAULT 0
    CHECK (rpm_limit >= 0),
  tpm_limit INTEGER NOT NULL DEFAULT 0
    CHECK (tpm_limit >= 0),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (account_ref, model_id),
  FOREIGN KEY (account_ref) REFERENCES accounts(account_ref) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS client_key_request_minute (
  minute_ms INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  surface TEXT NOT NULL DEFAULT '',
  requests INTEGER NOT NULL DEFAULT 0
    CHECK (requests >= 0),
  aborted_requests INTEGER NOT NULL DEFAULT 0
    CHECK (aborted_requests >= 0),
  PRIMARY KEY (minute_ms, key_id, surface)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS client_key_request_hour (
  hour_ms INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  surface TEXT NOT NULL DEFAULT '',
  requests INTEGER NOT NULL DEFAULT 0
    CHECK (requests >= 0),
  aborted_requests INTEGER NOT NULL DEFAULT 0
    CHECK (aborted_requests >= 0),
  PRIMARY KEY (hour_ms, key_id, surface)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS client_key_attempt_minute (
  minute_ms INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  provider_id TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL DEFAULT '',
  account_ref TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0
    CHECK (attempts >= 0),
  successes INTEGER NOT NULL DEFAULT 0
    CHECK (successes >= 0),
  failures INTEGER NOT NULL DEFAULT 0
    CHECK (failures >= 0),
  aborted INTEGER NOT NULL DEFAULT 0
    CHECK (aborted >= 0),
  input_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (output_tokens >= 0),
  cached_input_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (cached_input_tokens >= 0),
  cache_write_input_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (cache_write_input_tokens >= 0),
  reasoning_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (reasoning_tokens >= 0),
  total_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (total_tokens >= 0),
  PRIMARY KEY (minute_ms, key_id, provider_id, model_id, account_ref)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS client_key_attempt_hour (
  hour_ms INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  provider_id TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL DEFAULT '',
  account_ref TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0
    CHECK (attempts >= 0),
  successes INTEGER NOT NULL DEFAULT 0
    CHECK (successes >= 0),
  failures INTEGER NOT NULL DEFAULT 0
    CHECK (failures >= 0),
  aborted INTEGER NOT NULL DEFAULT 0
    CHECK (aborted >= 0),
  input_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (output_tokens >= 0),
  cached_input_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (cached_input_tokens >= 0),
  cache_write_input_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (cache_write_input_tokens >= 0),
  reasoning_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (reasoning_tokens >= 0),
  total_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (total_tokens >= 0),
  PRIMARY KEY (hour_ms, key_id, provider_id, model_id, account_ref)
) STRICT, WITHOUT ROWID;
