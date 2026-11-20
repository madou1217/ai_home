package managementops

const (
	rollupHourMS                  int64 = 60 * 60 * 1000
	rollupMaterializeExpandStepMS int64 = 15 * 60 * 1000
	rollupMaterializeMaxExpandMS  int64 = 2 * rollupHourMS
	rollupStreamingChunkHours     int64 = 7 * 24
	rollupAttributedChunkHours    int64 = 24
)

type rollupTableSpec struct {
	name    string
	columns []string
	ddl     string
}

var requiredRollupTables = []rollupTableSpec{
	{
		name:    "model_usage_rollup_meta",
		columns: []string{"key", "int_val", "text_val"},
		ddl: `CREATE TABLE IF NOT EXISTS model_usage_rollup_meta (
			key TEXT PRIMARY KEY,
			int_val INTEGER NOT NULL DEFAULT 0,
			text_val TEXT NOT NULL DEFAULT ''
		)`,
	},
	{
		name:    "model_usage_rollup_coverage",
		columns: []string{"start_hour_ms", "end_hour_ms"},
		ddl: `CREATE TABLE IF NOT EXISTS model_usage_rollup_coverage (
			start_hour_ms INTEGER PRIMARY KEY,
			end_hour_ms INTEGER NOT NULL
		)`,
	},
	{
		name:    "model_usage_rollup_dirty_hours",
		columns: []string{"hour_ms", "dirty_rev", "reason_mask"},
		ddl: `CREATE TABLE IF NOT EXISTS model_usage_rollup_dirty_hours (
			hour_ms INTEGER PRIMARY KEY,
			dirty_rev INTEGER NOT NULL DEFAULT 0,
			reason_mask INTEGER NOT NULL DEFAULT 1
		)`,
	},
	{
		name: "model_usage_rollup_hours",
		columns: []string{
			"hour_ms", "max_record_id", "max_prompt_rowid",
			"attr_count", "attr_digest", "fork_digest",
			"pricing_rev", "pricing_custom_digest",
			"has_codex_file", "has_left_boundary_attr", "has_right_boundary_attr", "built_at_ms",
		},
		ddl: `CREATE TABLE IF NOT EXISTS model_usage_rollup_hours (
			hour_ms INTEGER PRIMARY KEY,
			max_record_id INTEGER NOT NULL DEFAULT 0,
			max_prompt_rowid INTEGER NOT NULL DEFAULT 0,
			attr_count INTEGER NOT NULL DEFAULT 0,
			attr_digest INTEGER NOT NULL DEFAULT 0,
			fork_digest INTEGER NOT NULL DEFAULT 0,
			pricing_rev INTEGER NOT NULL DEFAULT 0,
			pricing_custom_digest INTEGER NOT NULL DEFAULT 0,
			has_codex_file INTEGER NOT NULL DEFAULT 0,
			has_left_boundary_attr INTEGER NOT NULL DEFAULT 0,
			has_right_boundary_attr INTEGER NOT NULL DEFAULT 0,
			built_at_ms INTEGER NOT NULL DEFAULT 0
		)`,
	},
	{
		name: "model_usage_rollup_hourly_model",
		columns: []string{
			"hour_ms", "provider", "model", "account_ref", "account_provider",
			"calls", "input_tokens", "output_tokens", "cache_read_input_tokens",
			"cache_creation_input_tokens", "reasoning_output_tokens", "total_tokens", "cost_usd",
		},
		ddl: `CREATE TABLE IF NOT EXISTS model_usage_rollup_hourly_model (
			hour_ms INTEGER NOT NULL,
			provider TEXT NOT NULL,
			model TEXT NOT NULL,
			account_ref TEXT NOT NULL,
			account_provider TEXT NOT NULL DEFAULT '',
			calls INTEGER NOT NULL DEFAULT 0,
			input_tokens INTEGER NOT NULL DEFAULT 0,
			output_tokens INTEGER NOT NULL DEFAULT 0,
			cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
			cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
			reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
			total_tokens INTEGER NOT NULL DEFAULT 0,
			cost_usd REAL NOT NULL DEFAULT 0,
			PRIMARY KEY (hour_ms, provider, model, account_ref, account_provider)
		) WITHOUT ROWID`,
	},
	{
		name: "model_usage_rollup_hourly_session",
		columns: []string{
			"hour_ms", "provider", "session_id", "model", "account_ref", "account_provider",
			"calls", "input_tokens", "output_tokens", "cache_read_input_tokens",
			"cache_creation_input_tokens", "reasoning_output_tokens", "total_tokens", "cost_usd",
			"min_timestamp_ms", "max_timestamp_ms", "max_project", "max_cwd", "max_git_branch",
		},
		ddl: `CREATE TABLE IF NOT EXISTS model_usage_rollup_hourly_session (
			hour_ms INTEGER NOT NULL,
			provider TEXT NOT NULL,
			session_id TEXT NOT NULL,
			model TEXT NOT NULL,
			account_ref TEXT NOT NULL,
			account_provider TEXT NOT NULL DEFAULT '',
			calls INTEGER NOT NULL DEFAULT 0,
			input_tokens INTEGER NOT NULL DEFAULT 0,
			output_tokens INTEGER NOT NULL DEFAULT 0,
			cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
			cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
			reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
			total_tokens INTEGER NOT NULL DEFAULT 0,
			cost_usd REAL NOT NULL DEFAULT 0,
			min_timestamp_ms INTEGER NOT NULL DEFAULT 0,
			max_timestamp_ms INTEGER NOT NULL DEFAULT 0,
			max_project TEXT NOT NULL DEFAULT '',
			max_cwd TEXT NOT NULL DEFAULT '',
			max_git_branch TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (hour_ms, provider, session_id, model, account_ref, account_provider)
		) WITHOUT ROWID`,
	},
	{
		name:    "model_usage_rollup_hourly_prompt",
		columns: []string{"hour_ms", "provider", "session_id", "prompt_count"},
		ddl: `CREATE TABLE IF NOT EXISTS model_usage_rollup_hourly_prompt (
			hour_ms INTEGER NOT NULL,
			provider TEXT NOT NULL,
			session_id TEXT NOT NULL,
			prompt_count INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (hour_ms, provider, session_id)
		) WITHOUT ROWID`,
	},
	{
		name: "model_usage_rollup_attributions",
		columns: []string{
			"scanner_id", "proxy_id", "scanner_timestamp_ms", "proxy_timestamp_ms",
			"scanner_hour_ms", "proxy_hour_ms", "model", "account_provider", "account_ref", "cost_usd",
		},
		ddl: `CREATE TABLE IF NOT EXISTS model_usage_rollup_attributions (
			scanner_id INTEGER PRIMARY KEY,
			proxy_id INTEGER NOT NULL UNIQUE,
			scanner_timestamp_ms INTEGER NOT NULL,
			proxy_timestamp_ms INTEGER NOT NULL,
			scanner_hour_ms INTEGER NOT NULL,
			proxy_hour_ms INTEGER NOT NULL,
			model TEXT NOT NULL,
			account_provider TEXT NOT NULL,
			account_ref TEXT NOT NULL,
			cost_usd REAL NOT NULL
		)`,
	},
}

type rollupIndexSpec struct {
	name string
	ddl  string
}

var requiredRollupIndexes = []rollupIndexSpec{
	{
		name: "idx_usage_rollup_attr_scanner_hour",
		ddl:  `CREATE INDEX IF NOT EXISTS idx_usage_rollup_attr_scanner_hour ON model_usage_rollup_attributions(scanner_hour_ms)`,
	},
	{
		name: "idx_usage_rollup_attr_proxy_hour",
		ddl:  `CREATE INDEX IF NOT EXISTS idx_usage_rollup_attr_proxy_hour ON model_usage_rollup_attributions(proxy_hour_ms)`,
	},
}

type rollupTriggerDef struct {
	name string
	ddl  string
}
