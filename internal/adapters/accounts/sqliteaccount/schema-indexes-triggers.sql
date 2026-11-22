-- 账号数据库（aih.db）核心索引与宿主默认所有权触发器。
--
-- 在全部必需表与增量列补齐之后执行，保证旧库新增列（如 credential_ref、
-- source_key、quota_bucket）上的索引与触发器可幂等创建。

CREATE INDEX IF NOT EXISTS idx_accounts_routing
  ON accounts (provider_id, account_ref, cli_account_id)
  WHERE enabled = 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_credentials_credential_ref
  ON account_credentials (credential_ref);

CREATE INDEX IF NOT EXISTS idx_account_models_effective
  ON account_models (model_id, account_ref)
  WHERE manual_policy = 'force_enable'
     OR (manual_policy = 'inherit' AND upstream_available = 1);

CREATE INDEX IF NOT EXISTS idx_account_outcomes_bucket
  ON account_outcomes (granularity, bucket_start_ms);

CREATE INDEX IF NOT EXISTS idx_account_runtime_state_cooldown
  ON account_runtime_state (cooldown_until_ms);

CREATE INDEX IF NOT EXISTS idx_usage_ledger_time
  ON usage_ledger (occurred_at_ms);

CREATE INDEX IF NOT EXISTS idx_usage_ledger_provider_model_time
  ON usage_ledger (provider_id, model_id, occurred_at_ms);

CREATE INDEX IF NOT EXISTS idx_usage_ledger_account_time
  ON usage_ledger (account_ref, occurred_at_ms);

CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_ledger_source_key
  ON usage_ledger (source_key)
  WHERE source_key <> '';

CREATE INDEX IF NOT EXISTS idx_usage_ledger_quota_bucket_cover ON usage_ledger(
  occurred_at_ms,
  provider_id,
  quota_bucket,
  input_tokens,
  output_tokens,
  cached_input_tokens,
  cache_write_input_tokens,
  reasoning_tokens,
  total_tokens
);

CREATE INDEX IF NOT EXISTS idx_account_tombstones_ref
  ON account_tombstones (account_ref);

CREATE INDEX IF NOT EXISTS idx_account_tombstones_key
  ON account_tombstones (provider_id, kind, fingerprint);

CREATE INDEX IF NOT EXISTS idx_account_usage_snapshots_provider
  ON account_usage_snapshots(provider_id, account_ref);

CREATE INDEX IF NOT EXISTS idx_account_runtime_blocks_until
  ON account_runtime_blocks(until_ms);

CREATE INDEX IF NOT EXISTS idx_account_runtime_states_updated
  ON account_runtime_states(updated_at_ms);

CREATE INDEX IF NOT EXISTS idx_oauth_jobs_provider_status
  ON oauth_jobs(provider_id, status);

CREATE INDEX IF NOT EXISTS idx_oauth_jobs_updated_at
  ON oauth_jobs(updated_at_ms);

CREATE INDEX IF NOT EXISTS idx_quota_window_samples_account_key_time
  ON account_quota_window_samples (account_ref, quota_key, captured_at_ms);

CREATE INDEX IF NOT EXISTS idx_quota_window_samples_time
  ON account_quota_window_samples (captured_at_ms);

CREATE INDEX IF NOT EXISTS idx_quota_reset_events_account_key_time
  ON account_quota_reset_events (account_ref, quota_key, occurred_at_ms);

CREATE INDEX IF NOT EXISTS idx_quota_reset_events_account_time
  ON account_quota_reset_events (account_ref, occurred_at_ms);

CREATE INDEX IF NOT EXISTS model_alias_order
  ON model_alias (position);

CREATE UNIQUE INDEX IF NOT EXISTS idx_upstream_error_mapping_group_position
  ON upstream_error_mapping_group (position);

CREATE INDEX IF NOT EXISTS idx_account_upstream_error_group_group
  ON account_upstream_error_group (group_id);

CREATE INDEX IF NOT EXISTS idx_session_index_scope
  ON session_index (provider, account_ref, updated_at_ms DESC);

CREATE TRIGGER IF NOT EXISTS trg_account_defaults_clear_disabled
AFTER UPDATE OF enabled ON accounts
FOR EACH ROW
WHEN OLD.enabled = 1 AND NEW.enabled = 0
BEGIN
  DELETE FROM account_defaults WHERE account_ref = NEW.account_ref;
END;

CREATE TRIGGER IF NOT EXISTS guard_owned_default_insert BEFORE INSERT ON account_defaults
WHEN EXISTS (SELECT 1 FROM account_default_ownership o
  WHERE o.provider_id = NEW.provider_id
    AND (o.expected_ref IS NULL OR o.expected_ref <> NEW.account_ref))
BEGIN SELECT RAISE(ABORT, 'host_default_write_requires_projection'); END;

CREATE TRIGGER IF NOT EXISTS guard_owned_default_update BEFORE UPDATE ON account_defaults
WHEN EXISTS (SELECT 1 FROM account_default_ownership o
  WHERE o.provider_id = NEW.provider_id
    AND (o.expected_ref IS NULL OR o.expected_ref <> NEW.account_ref))
BEGIN SELECT RAISE(ABORT, 'host_default_write_requires_projection'); END;

CREATE TRIGGER IF NOT EXISTS guard_owned_default_delete BEFORE DELETE ON account_defaults
WHEN EXISTS (SELECT 1 FROM account_default_ownership o
  WHERE o.provider_id = OLD.provider_id AND o.expected_ref IS NOT NULL)
  AND EXISTS (SELECT 1 FROM accounts a WHERE a.account_ref = OLD.account_ref AND a.enabled = 1)
BEGIN SELECT RAISE(ABORT, 'host_default_write_requires_projection'); END;

CREATE TRIGGER IF NOT EXISTS release_deleted_default_owner AFTER DELETE ON accounts
BEGIN UPDATE account_default_ownership SET expected_ref = NULL
  WHERE expected_ref = OLD.account_ref; END;

CREATE UNIQUE INDEX IF NOT EXISTS idx_client_api_keys_hash
  ON client_api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_client_api_keys_state
  ON client_api_keys(revoked_at_ms, enabled);
CREATE INDEX IF NOT EXISTS idx_client_key_request_minute_key
  ON client_key_request_minute(key_id, minute_ms);
CREATE INDEX IF NOT EXISTS idx_client_key_request_hour_key
  ON client_key_request_hour(key_id, hour_ms);
CREATE INDEX IF NOT EXISTS idx_client_key_attempt_minute_key
  ON client_key_attempt_minute(key_id, minute_ms);
CREATE INDEX IF NOT EXISTS idx_client_key_attempt_minute_account
  ON client_key_attempt_minute(account_ref, minute_ms);
CREATE INDEX IF NOT EXISTS idx_client_key_attempt_minute_model
  ON client_key_attempt_minute(provider_id, model_id, minute_ms);
CREATE INDEX IF NOT EXISTS idx_client_key_attempt_hour_key
  ON client_key_attempt_hour(key_id, hour_ms);
CREATE INDEX IF NOT EXISTS idx_client_key_attempt_hour_account
  ON client_key_attempt_hour(account_ref, hour_ms);
CREATE INDEX IF NOT EXISTS idx_client_key_attempt_hour_model
  ON client_key_attempt_hour(provider_id, model_id, hour_ms);
