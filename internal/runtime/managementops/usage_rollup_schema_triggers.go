package managementops

var rollupTriggerDefs = []rollupTriggerDef{
	{
		name: "trg_usage_rollup_records_ai",
		ddl: `CREATE TRIGGER IF NOT EXISTS trg_usage_rollup_records_ai
AFTER INSERT ON model_usage_records
BEGIN
	UPDATE model_usage_rollup_meta SET int_val = int_val + 1 WHERE key = 'change_rev';
	INSERT INTO model_usage_rollup_dirty_hours (hour_ms, dirty_rev, reason_mask)
	SELECT h, COALESCE((SELECT int_val FROM model_usage_rollup_meta WHERE key = 'change_rev'), 0), 1
	FROM (
		SELECT CASE WHEN new.timestamp_ms > 0 THEN (new.timestamp_ms / 3600000) * 3600000 ELSE 0 END AS h
		UNION
		SELECT ((new.timestamp_ms / 3600000) - 1) * 3600000 AS h
		WHERE new.timestamp_ms >= 3600000
			AND (new.timestamp_ms % 3600000) < 300000
			AND (new.source_kind IN ('session_jsonl', 'session_json') OR new.source_kind GLOB 'server_*')
		UNION
		SELECT ((new.timestamp_ms / 3600000) + 1) * 3600000 AS h
		WHERE new.timestamp_ms > 0
			AND new.timestamp_ms < 9223372036850000000
			AND (new.timestamp_ms % 3600000) >= 3300000
			AND (new.source_kind IN ('session_jsonl', 'session_json') OR new.source_kind GLOB 'server_*')
	)
	WHERE 1
	ON CONFLICT(hour_ms) DO UPDATE SET
		dirty_rev = excluded.dirty_rev,
		reason_mask = reason_mask | excluded.reason_mask;
END`,
	},
	{
		name: "trg_usage_rollup_records_au",
		ddl: `CREATE TRIGGER IF NOT EXISTS trg_usage_rollup_records_au
AFTER UPDATE ON model_usage_records
BEGIN
	UPDATE model_usage_rollup_meta SET int_val = int_val + 1 WHERE key = 'change_rev';
	INSERT INTO model_usage_rollup_dirty_hours (hour_ms, dirty_rev, reason_mask)
	SELECT h, COALESCE((SELECT int_val FROM model_usage_rollup_meta WHERE key = 'change_rev'), 0), 1
	FROM (
		SELECT CASE WHEN old.timestamp_ms > 0 THEN (old.timestamp_ms / 3600000) * 3600000 ELSE 0 END AS h
		UNION
		SELECT CASE WHEN new.timestamp_ms > 0 THEN (new.timestamp_ms / 3600000) * 3600000 ELSE 0 END AS h
		UNION
		SELECT ((old.timestamp_ms / 3600000) - 1) * 3600000 AS h
		WHERE old.timestamp_ms >= 3600000
			AND (old.timestamp_ms % 3600000) < 300000
			AND (old.source_kind IN ('session_jsonl', 'session_json') OR old.source_kind GLOB 'server_*')
		UNION
		SELECT ((old.timestamp_ms / 3600000) + 1) * 3600000 AS h
		WHERE old.timestamp_ms > 0
			AND old.timestamp_ms < 9223372036850000000
			AND (old.timestamp_ms % 3600000) >= 3300000
			AND (old.source_kind IN ('session_jsonl', 'session_json') OR old.source_kind GLOB 'server_*')
		UNION
		SELECT ((new.timestamp_ms / 3600000) - 1) * 3600000 AS h
		WHERE new.timestamp_ms >= 3600000
			AND (new.timestamp_ms % 3600000) < 300000
			AND (new.source_kind IN ('session_jsonl', 'session_json') OR new.source_kind GLOB 'server_*')
		UNION
		SELECT ((new.timestamp_ms / 3600000) + 1) * 3600000 AS h
		WHERE new.timestamp_ms > 0
			AND new.timestamp_ms < 9223372036850000000
			AND (new.timestamp_ms % 3600000) >= 3300000
			AND (new.source_kind IN ('session_jsonl', 'session_json') OR new.source_kind GLOB 'server_*')
	)
	WHERE 1
	ON CONFLICT(hour_ms) DO UPDATE SET
		dirty_rev = excluded.dirty_rev,
		reason_mask = reason_mask | excluded.reason_mask;
END`,
	},
	{
		name: "trg_usage_rollup_records_ad",
		ddl: `CREATE TRIGGER IF NOT EXISTS trg_usage_rollup_records_ad
AFTER DELETE ON model_usage_records
BEGIN
	UPDATE model_usage_rollup_meta SET int_val = int_val + 1 WHERE key = 'change_rev';
	INSERT INTO model_usage_rollup_dirty_hours (hour_ms, dirty_rev, reason_mask)
	SELECT h, COALESCE((SELECT int_val FROM model_usage_rollup_meta WHERE key = 'change_rev'), 0), 1
	FROM (
		SELECT CASE WHEN old.timestamp_ms > 0 THEN (old.timestamp_ms / 3600000) * 3600000 ELSE 0 END AS h
		UNION
		SELECT ((old.timestamp_ms / 3600000) - 1) * 3600000 AS h
		WHERE old.timestamp_ms >= 3600000
			AND (old.timestamp_ms % 3600000) < 300000
			AND (old.source_kind IN ('session_jsonl', 'session_json') OR old.source_kind GLOB 'server_*')
		UNION
		SELECT ((old.timestamp_ms / 3600000) + 1) * 3600000 AS h
		WHERE old.timestamp_ms > 0
			AND old.timestamp_ms < 9223372036850000000
			AND (old.timestamp_ms % 3600000) >= 3300000
			AND (old.source_kind IN ('session_jsonl', 'session_json') OR old.source_kind GLOB 'server_*')
	)
	WHERE 1
	ON CONFLICT(hour_ms) DO UPDATE SET
		dirty_rev = excluded.dirty_rev,
		reason_mask = reason_mask | excluded.reason_mask;
END`,
	},
	{
		name: "trg_usage_rollup_prompts_ai",
		ddl: `CREATE TRIGGER IF NOT EXISTS trg_usage_rollup_prompts_ai
AFTER INSERT ON model_usage_prompt_events
BEGIN
	UPDATE model_usage_rollup_meta SET int_val = int_val + 1 WHERE key = 'change_rev';
	INSERT INTO model_usage_rollup_dirty_hours (hour_ms, dirty_rev, reason_mask)
	VALUES (
		CASE WHEN new.timestamp_ms > 0 THEN (new.timestamp_ms / 3600000) * 3600000 ELSE 0 END,
		COALESCE((SELECT int_val FROM model_usage_rollup_meta WHERE key = 'change_rev'), 0),
		2
	)
	ON CONFLICT(hour_ms) DO UPDATE SET
		dirty_rev = excluded.dirty_rev,
		reason_mask = reason_mask | excluded.reason_mask;
END`,
	},
	{
		name: "trg_usage_rollup_prompts_au",
		ddl: `CREATE TRIGGER IF NOT EXISTS trg_usage_rollup_prompts_au
AFTER UPDATE ON model_usage_prompt_events
BEGIN
	UPDATE model_usage_rollup_meta SET int_val = int_val + 1 WHERE key = 'change_rev';
	INSERT INTO model_usage_rollup_dirty_hours (hour_ms, dirty_rev, reason_mask)
	SELECT h, COALESCE((SELECT int_val FROM model_usage_rollup_meta WHERE key = 'change_rev'), 0), 2
	FROM (
		SELECT CASE WHEN old.timestamp_ms > 0 THEN (old.timestamp_ms / 3600000) * 3600000 ELSE 0 END AS h
		UNION
		SELECT CASE WHEN new.timestamp_ms > 0 THEN (new.timestamp_ms / 3600000) * 3600000 ELSE 0 END AS h
	)
	WHERE 1
	ON CONFLICT(hour_ms) DO UPDATE SET
		dirty_rev = excluded.dirty_rev,
		reason_mask = reason_mask | excluded.reason_mask;
END`,
	},
	{
		name: "trg_usage_rollup_prompts_ad",
		ddl: `CREATE TRIGGER IF NOT EXISTS trg_usage_rollup_prompts_ad
AFTER DELETE ON model_usage_prompt_events
BEGIN
	UPDATE model_usage_rollup_meta SET int_val = int_val + 1 WHERE key = 'change_rev';
	INSERT INTO model_usage_rollup_dirty_hours (hour_ms, dirty_rev, reason_mask)
	VALUES (
		CASE WHEN old.timestamp_ms > 0 THEN (old.timestamp_ms / 3600000) * 3600000 ELSE 0 END,
		COALESCE((SELECT int_val FROM model_usage_rollup_meta WHERE key = 'change_rev'), 0),
		2
	)
	ON CONFLICT(hour_ms) DO UPDATE SET
		dirty_rev = excluded.dirty_rev,
		reason_mask = reason_mask | excluded.reason_mask;
END`,
	},
	{
		name: "trg_usage_rollup_filestate_ai",
		ddl: `CREATE TRIGGER IF NOT EXISTS trg_usage_rollup_filestate_ai
AFTER INSERT ON model_usage_file_state
WHEN new.scan_context LIKE '%"codexForkSession":true%'
BEGIN
	UPDATE model_usage_rollup_meta SET int_val = int_val + 1 WHERE key IN ('change_rev', 'fork_rev');
END`,
	},
	{
		name: "trg_usage_rollup_filestate_au",
		ddl: `CREATE TRIGGER IF NOT EXISTS trg_usage_rollup_filestate_au
AFTER UPDATE ON model_usage_file_state
WHEN new.scan_context LIKE '%"codexForkSession":true%' OR old.scan_context LIKE '%"codexForkSession":true%'
BEGIN
	UPDATE model_usage_rollup_meta SET int_val = int_val + 1 WHERE key IN ('change_rev', 'fork_rev');
END`,
	},
	{
		name: "trg_usage_rollup_filestate_ad",
		ddl: `CREATE TRIGGER IF NOT EXISTS trg_usage_rollup_filestate_ad
AFTER DELETE ON model_usage_file_state
WHEN old.scan_context LIKE '%"codexForkSession":true%'
BEGIN
	UPDATE model_usage_rollup_meta SET int_val = int_val + 1 WHERE key IN ('change_rev', 'fork_rev');
END`,
	},
	{
		name: "trg_usage_rollup_pricing_ai",
		ddl: `CREATE TRIGGER IF NOT EXISTS trg_usage_rollup_pricing_ai
AFTER INSERT ON model_usage_pricing
BEGIN
	UPDATE model_usage_rollup_meta SET int_val = int_val + 1 WHERE key IN ('change_rev', 'pricing_rev');
END`,
	},
	{
		name: "trg_usage_rollup_pricing_au",
		ddl: `CREATE TRIGGER IF NOT EXISTS trg_usage_rollup_pricing_au
AFTER UPDATE ON model_usage_pricing
BEGIN
	UPDATE model_usage_rollup_meta SET int_val = int_val + 1 WHERE key IN ('change_rev', 'pricing_rev');
END`,
	},
	{
		name: "trg_usage_rollup_pricing_ad",
		ddl: `CREATE TRIGGER IF NOT EXISTS trg_usage_rollup_pricing_ad
AFTER DELETE ON model_usage_pricing
BEGIN
	UPDATE model_usage_rollup_meta SET int_val = int_val + 1 WHERE key IN ('change_rev', 'pricing_rev');
END`,
	},
	{
		name: "trg_usage_rollup_appkv_ai",
		ddl: `CREATE TRIGGER IF NOT EXISTS trg_usage_rollup_appkv_ai
AFTER INSERT ON app_kv
WHEN new.key IN ('active:model_usage_pricing', 'model-catalog-settings')
BEGIN
	UPDATE model_usage_rollup_meta SET int_val = int_val + 1 WHERE key IN ('change_rev', 'pricing_rev');
END`,
	},
	{
		name: "trg_usage_rollup_appkv_au",
		ddl: `CREATE TRIGGER IF NOT EXISTS trg_usage_rollup_appkv_au
AFTER UPDATE ON app_kv
WHEN new.key IN ('active:model_usage_pricing', 'model-catalog-settings')
	OR old.key IN ('active:model_usage_pricing', 'model-catalog-settings')
BEGIN
	UPDATE model_usage_rollup_meta SET int_val = int_val + 1 WHERE key IN ('change_rev', 'pricing_rev');
END`,
	},
	{
		name: "trg_usage_rollup_appkv_ad",
		ddl: `CREATE TRIGGER IF NOT EXISTS trg_usage_rollup_appkv_ad
AFTER DELETE ON app_kv
WHEN old.key IN ('active:model_usage_pricing', 'model-catalog-settings')
BEGIN
	UPDATE model_usage_rollup_meta SET int_val = int_val + 1 WHERE key IN ('change_rev', 'pricing_rev');
END`,
	},
	{
		name: "trg_usage_rollup_sessions_ai",
		ddl: `CREATE TRIGGER IF NOT EXISTS trg_usage_rollup_sessions_ai
AFTER INSERT ON model_usage_sessions
BEGIN
	UPDATE model_usage_rollup_meta SET int_val = int_val + 1 WHERE key = 'change_rev';
END`,
	},
	{
		name: "trg_usage_rollup_sessions_au",
		ddl: `CREATE TRIGGER IF NOT EXISTS trg_usage_rollup_sessions_au
AFTER UPDATE ON model_usage_sessions
BEGIN
	UPDATE model_usage_rollup_meta SET int_val = int_val + 1 WHERE key = 'change_rev';
END`,
	},
	{
		name: "trg_usage_rollup_sessions_ad",
		ddl: `CREATE TRIGGER IF NOT EXISTS trg_usage_rollup_sessions_ad
AFTER DELETE ON model_usage_sessions
BEGIN
	UPDATE model_usage_rollup_meta SET int_val = int_val + 1 WHERE key = 'change_rev';
END`,
	},
}
