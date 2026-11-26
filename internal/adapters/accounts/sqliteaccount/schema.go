// Package sqliteaccount 提供账号持久化端口的 SQLite 适配器。
package sqliteaccount

import _ "embed"

const (
	// ApplicationID 是 aih.db 的 SQLite application_id，十六进制表示为 0x41494831。
	ApplicationID = 1_095_321_649
)

// SchemaBaselineSQL 是 aih.db 全部核心业务表的幂等终态建表脚本（不含版本号门禁）。
//
//go:embed schema.sql
var SchemaBaselineSQL string

// SchemaIndexesAndTriggersSQL 是核心索引与默认账号所有权触发器的幂等定义脚本。
//
//go:embed schema-indexes-triggers.sql
var SchemaIndexesAndTriggersSQL string

// SchemaUsageLedgerDailySQL 是 usage_ledger_daily 派生汇总表及增删改完整性触发器脚本。
//
//go:embed schema-usage-ledger-daily.sql
var SchemaUsageLedgerDailySQL string

// requiredTableColumns 声明当前运行时读取或写入所需的最小列集合。
//
// 校验按“必需子集”判定（不绑定列顺序与列总数），保留未知新表与表上新增列。
var requiredTableColumns = map[string][]string{
	"accounts": {
		"account_ref", "provider_id", "cli_account_id", "enabled",
		"created_at_ms", "updated_at_ms",
	},
	"account_credentials": {
		"account_ref", "credential_ref", "auth_kind", "auth_mode",
		"format_version", "credential_json", "updated_at_ms",
	},
	"account_profiles": {
		"account_ref", "display_name", "email", "subscription_kind",
		"subscription_raw", "format_version", "profile_json",
		"updated_at_ms", "workspace_id",
	},
	"account_models": {
		"account_ref", "model_id", "upstream_available", "manual_policy",
		"updated_at_ms",
	},
	"account_usage": {
		"account_ref", "limit_id", "limit_name", "bucket", "kind", "scope",
		"scope_key", "remaining_bps", "availability", "window_seconds",
		"reset_at_ms", "source", "captured_at_ms", "plan_type",
	},
	"account_defaults": {
		"provider_id", "account_ref", "updated_at_ms",
	},
	"account_outcomes": {
		"account_ref", "granularity", "bucket_start_ms", "outcome", "count",
	},
	"account_runtime_state": {
		"account_ref", "model_id", "streak_kind", "streak_count",
		"streak_expires_at_ms", "cooldown_kind", "cooldown_until_ms",
		"last_failure_at_ms",
	},
	"usage_ledger": {
		"usage_id", "account_ref", "provider_id", "model_id", "session_id",
		"occurred_at_ms", "input_tokens", "output_tokens", "cached_input_tokens",
		"cache_write_input_tokens", "reasoning_tokens", "total_tokens",
		"source_key", "quota_bucket",
	},
	"usage_ledger_daily": {
		"day_ms", "account_ref", "provider_id", "model_id", "quota_bucket",
		"calls", "input_tokens", "output_tokens", "cached_input_tokens",
		"cache_write_input_tokens", "reasoning_tokens", "total_tokens",
	},
	"account_tombstones": {
		"tombstone_key", "account_ref", "provider_id", "kind", "fingerprint",
		"created_at_ms",
	},
	"account_usage_snapshots": {
		"account_ref", "provider_id", "kind", "source", "captured_at_ms",
		"payload_json", "quota_status", "quota_reason", "remaining_bps",
		"has_numeric_remaining",
	},
	"account_ui_state": {
		"account_ref", "status", "display_name", "auth_mode", "api_key_mode",
		"base_url", "updated_at_ms", "configured", "oauth_pending",
	},
	"account_runtime_blocks": {
		"account_ref", "kind", "scope", "reason", "observed_at_ms", "until_ms",
	},
	"account_runtime_states": {
		"account_ref", "state_json", "updated_at_ms",
	},
	"oauth_jobs": {
		"job_id", "provider_id", "purpose", "target_ref", "status",
		"created_at_ms", "expires_at_ms", "updated_at_ms", "error_code",
		"error_message", "account_ref", "cli_account_id", "finished_at_ms",
		"owner", "source",
	},
	"account_quota_window_samples": {
		"sample_id", "account_ref", "provider_id", "quota_key", "window_label",
		"window_minutes", "remaining_pct", "expected_reset_at_ms",
		"captured_at_ms", "captured_bucket", "plan_type", "created_at_ms",
	},
	"account_quota_window_ledger": {
		"account_ref", "window_minutes", "anchor_at_ms", "close_at_ms",
		"source", "observed_at_ms", "updated_at_ms",
	},
	"account_quota_detector_state": {
		"account_ref", "quota_key", "provider_id", "last_remaining_pct",
		"last_expected_reset_at_ms", "last_captured_at_ms", "is_armed",
		"rearm_generation", "exhausted_at_ms", "updated_at_ms",
	},
	"account_quota_reset_events": {
		"event_id", "event_key", "account_ref", "provider_id", "quota_key",
		"window_label", "window_minutes", "event_kind", "classification",
		"cause", "previous_remaining_pct", "current_remaining_pct",
		"previous_expected_reset_at_ms", "exhausted_at_ms", "occurred_at_ms",
		"detected_at_ms", "early_duration_ms", "created_at_ms",
	},
	"account_model_probes": {
		"account_ref", "provider_id", "last_attempt_at_ms", "last_error_code",
		"last_error_message", "last_source", "last_model_count", "updated_at_ms",
	},
	"model_alias": {
		"id", "alias", "target", "provider", "target_provider", "priority",
		"enabled", "description", "created_at_ms", "updated_at_ms", "position",
		"display_models_json",
	},
	"model_alias_meta": {
		"id", "generation",
	},
	"account_probe_state": {
		"account_ref", "status", "error", "checked_at_ms", "updated_at_ms",
	},
	"account_routing_exclusions": {
		"account_ref", "excluded", "reason", "updated_at_ms",
	},
	"upstream_error_mapping_group": {
		"id", "name", "description", "provider", "enabled", "position",
		"version", "created_at_ms", "updated_at_ms",
	},
	"upstream_error_mapping_rule": {
		"group_id", "position", "rule_json",
	},
	"account_upstream_error_rule": {
		"account_ref", "source", "position", "rule_json",
	},
	"account_upstream_error_group": {
		"account_ref", "position", "group_id",
	},
	"account_default_ownership": {
		"provider_id", "owner", "expected_ref", "operation_id", "updated_at_ms",
	},
	"session_index": {
		"provider", "account_ref", "project_id", "project_name", "project_path",
		"session_id", "title", "updated_at_ms", "project_dir_name", "scanned_at_ms",
	},
	"session_index_state": {
		"provider", "account_ref", "scanned_at_ms", "truncated",
	},
	"client_api_keys": {
		"key_id", "name", "key_hash", "key_secret", "key_prefix", "enabled",
		"created_at_ms", "updated_at_ms", "last_used_at_ms", "revoked_at_ms",
		"allowed_providers_json", "allowed_models_json",
		"max_concurrency", "rpm_limit", "tpm_limit", "daily_token_limit", "notes",
	},
	"account_concurrency_limits": {
		"account_ref", "model_id", "max_concurrency", "rpm_limit", "tpm_limit",
		"updated_at_ms",
	},
	"client_key_request_minute": {
		"minute_ms", "key_id", "surface", "requests", "aborted_requests",
	},
	"client_key_request_hour": {
		"hour_ms", "key_id", "surface", "requests", "aborted_requests",
	},
	"client_key_attempt_minute": {
		"minute_ms", "key_id", "provider_id", "model_id", "account_ref",
		"attempts", "successes", "failures", "aborted",
		"input_tokens", "output_tokens", "cached_input_tokens",
		"cache_write_input_tokens", "reasoning_tokens", "total_tokens",
	},
	"client_key_attempt_hour": {
		"hour_ms", "key_id", "provider_id", "model_id", "account_ref",
		"attempts", "successes", "failures", "aborted",
		"input_tokens", "output_tokens", "cached_input_tokens",
		"cache_write_input_tokens", "reasoning_tokens", "total_tokens",
	},
}

var requiredIndexNames = []string{
	"idx_accounts_routing",
	"idx_account_credentials_credential_ref",
	"idx_account_models_effective",
	"idx_account_outcomes_bucket",
	"idx_account_runtime_state_cooldown",
	"idx_usage_ledger_time",
	"idx_usage_ledger_provider_model_time",
	"idx_usage_ledger_account_time",
	"idx_usage_ledger_source_key",
	"idx_usage_ledger_quota_bucket_cover",
	"idx_client_api_keys_hash",
	"idx_client_api_keys_state",
	"idx_client_key_request_minute_key",
	"idx_client_key_request_hour_key",
	"idx_client_key_attempt_minute_key",
	"idx_client_key_attempt_minute_account",
	"idx_client_key_attempt_minute_model",
	"idx_client_key_attempt_hour_key",
	"idx_client_key_attempt_hour_account",
	"idx_client_key_attempt_hour_model",
	"idx_account_tombstones_ref",
	"idx_account_tombstones_key",
	"idx_account_usage_snapshots_provider",
	"idx_account_runtime_blocks_until",
	"idx_account_runtime_states_updated",
	"idx_oauth_jobs_provider_status",
	"idx_oauth_jobs_updated_at",
	"idx_quota_window_samples_account_key_time",
	"idx_quota_window_samples_time",
	"idx_quota_reset_events_account_key_time",
	"idx_quota_reset_events_account_time",
	"model_alias_order",
	"idx_upstream_error_mapping_group_position",
	"idx_account_upstream_error_group_group",
	"idx_session_index_scope",
}

var requiredCoreTriggerNames = []string{
	"trg_account_defaults_clear_disabled",
	"guard_owned_default_insert",
	"guard_owned_default_update",
	"guard_owned_default_delete",
	"release_deleted_default_owner",
}
