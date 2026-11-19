package sqliteaccount

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

const (
	triggerNameLedgerDailyAfterInsert = "usage_ledger_daily_after_insert"
	triggerNameLedgerDailyAfterDelete = "usage_ledger_daily_after_delete"
	triggerNameLedgerDailyAfterUpdate = "usage_ledger_daily_after_update"
)

var expectedLedgerDailyTriggers = map[string]string{
	triggerNameLedgerDailyAfterInsert: canonicalizeTriggerSQL(`
		CREATE TRIGGER usage_ledger_daily_after_insert
		AFTER INSERT ON usage_ledger
		BEGIN
		  INSERT INTO usage_ledger_daily (
		    day_ms, account_ref, provider_id, model_id, quota_bucket,
		    calls, input_tokens, output_tokens, cached_input_tokens,
		    cache_write_input_tokens, reasoning_tokens, total_tokens
		  ) VALUES (
		    new.occurred_at_ms / 86400000 * 86400000,
		    new.account_ref, new.provider_id, new.model_id, new.quota_bucket,
		    1, new.input_tokens, new.output_tokens, new.cached_input_tokens,
		    new.cache_write_input_tokens, new.reasoning_tokens, new.total_tokens
		  )
		  ON CONFLICT(day_ms, account_ref, provider_id, model_id, quota_bucket) DO UPDATE SET
		    calls = calls + 1,
		    input_tokens = input_tokens + excluded.input_tokens,
		    output_tokens = output_tokens + excluded.output_tokens,
		    cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
		    cache_write_input_tokens = cache_write_input_tokens + excluded.cache_write_input_tokens,
		    reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
		    total_tokens = total_tokens + excluded.total_tokens;
		END`),
	triggerNameLedgerDailyAfterDelete: canonicalizeTriggerSQL(`
		CREATE TRIGGER usage_ledger_daily_after_delete
		AFTER DELETE ON usage_ledger
		BEGIN
		  UPDATE usage_ledger_daily
		  SET calls = calls - 1,
		      input_tokens = input_tokens - COALESCE(old.input_tokens, 0),
		      output_tokens = output_tokens - COALESCE(old.output_tokens, 0),
		      cached_input_tokens = cached_input_tokens - COALESCE(old.cached_input_tokens, 0),
		      cache_write_input_tokens = cache_write_input_tokens - COALESCE(old.cache_write_input_tokens, 0),
		      reasoning_tokens = reasoning_tokens - COALESCE(old.reasoning_tokens, 0),
		      total_tokens = total_tokens - COALESCE(old.total_tokens, 0)
		  WHERE day_ms = ((old.occurred_at_ms / 86400000) * 86400000)
		    AND account_ref = old.account_ref
		    AND provider_id = old.provider_id
		    AND model_id = old.model_id
		    AND quota_bucket = old.quota_bucket;

		  DELETE FROM usage_ledger_daily
		  WHERE day_ms = ((old.occurred_at_ms / 86400000) * 86400000)
		    AND account_ref = old.account_ref
		    AND provider_id = old.provider_id
		    AND model_id = old.model_id
		    AND quota_bucket = old.quota_bucket
		    AND calls <= 0;
		END`),
	triggerNameLedgerDailyAfterUpdate: canonicalizeTriggerSQL(`
		CREATE TRIGGER usage_ledger_daily_after_update
		AFTER UPDATE OF
		  occurred_at_ms,
		  account_ref,
		  provider_id,
		  model_id,
		  quota_bucket,
		  input_tokens,
		  output_tokens,
		  cached_input_tokens,
		  cache_write_input_tokens,
		  reasoning_tokens,
		  total_tokens
		ON usage_ledger
		WHEN ((old.occurred_at_ms / 86400000) * 86400000) IS NOT ((new.occurred_at_ms / 86400000) * 86400000)
		  OR old.account_ref IS NOT new.account_ref
		  OR old.provider_id IS NOT new.provider_id
		  OR old.model_id IS NOT new.model_id
		  OR old.quota_bucket IS NOT new.quota_bucket
		  OR old.input_tokens IS NOT new.input_tokens
		  OR old.output_tokens IS NOT new.output_tokens
		  OR old.cached_input_tokens IS NOT new.cached_input_tokens
		  OR old.cache_write_input_tokens IS NOT new.cache_write_input_tokens
		  OR old.reasoning_tokens IS NOT new.reasoning_tokens
		  OR old.total_tokens IS NOT new.total_tokens
		BEGIN
		  UPDATE usage_ledger_daily
		  SET calls = calls - 1,
		      input_tokens = input_tokens - COALESCE(old.input_tokens, 0),
		      output_tokens = output_tokens - COALESCE(old.output_tokens, 0),
		      cached_input_tokens = cached_input_tokens - COALESCE(old.cached_input_tokens, 0),
		      cache_write_input_tokens = cache_write_input_tokens - COALESCE(old.cache_write_input_tokens, 0),
		      reasoning_tokens = reasoning_tokens - COALESCE(old.reasoning_tokens, 0),
		      total_tokens = total_tokens - COALESCE(old.total_tokens, 0)
		  WHERE day_ms = ((old.occurred_at_ms / 86400000) * 86400000)
		    AND account_ref = old.account_ref
		    AND provider_id = old.provider_id
		    AND model_id = old.model_id
		    AND quota_bucket = old.quota_bucket;

		  DELETE FROM usage_ledger_daily
		  WHERE day_ms = ((old.occurred_at_ms / 86400000) * 86400000)
		    AND account_ref = old.account_ref
		    AND provider_id = old.provider_id
		    AND model_id = old.model_id
		    AND quota_bucket = old.quota_bucket
		    AND calls <= 0;

		  INSERT INTO usage_ledger_daily (
		    day_ms, account_ref, provider_id, model_id, quota_bucket,
		    calls, input_tokens, output_tokens, cached_input_tokens,
		    cache_write_input_tokens, reasoning_tokens, total_tokens
		  ) VALUES (
		    (new.occurred_at_ms / 86400000) * 86400000,
		    new.account_ref, new.provider_id, new.model_id, new.quota_bucket,
		    1,
		    COALESCE(new.input_tokens, 0),
		    COALESCE(new.output_tokens, 0),
		    COALESCE(new.cached_input_tokens, 0),
		    COALESCE(new.cache_write_input_tokens, 0),
		    COALESCE(new.reasoning_tokens, 0),
		    COALESCE(new.total_tokens, 0)
		  )
		  ON CONFLICT(day_ms, account_ref, provider_id, model_id, quota_bucket) DO UPDATE SET
		    calls = calls + 1,
		    input_tokens = input_tokens + excluded.input_tokens,
		    output_tokens = output_tokens + excluded.output_tokens,
		    cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
		    cache_write_input_tokens = cache_write_input_tokens + excluded.cache_write_input_tokens,
		    reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
		    total_tokens = total_tokens + excluded.total_tokens;
		END`),
}

const reconcileUsageLedgerDailyInsertSQL = `
INSERT INTO usage_ledger_daily (
  day_ms, account_ref, provider_id, model_id, quota_bucket,
  calls, input_tokens, output_tokens, cached_input_tokens,
  cache_write_input_tokens, reasoning_tokens, total_tokens
)
SELECT (occurred_at_ms / 86400000) * 86400000,
       account_ref, provider_id, model_id, quota_bucket,
       COUNT(*),
       COALESCE(SUM(input_tokens), 0),
       COALESCE(SUM(output_tokens), 0),
       COALESCE(SUM(cached_input_tokens), 0),
       COALESCE(SUM(cache_write_input_tokens), 0),
       COALESCE(SUM(reasoning_tokens), 0),
       COALESCE(SUM(total_tokens), 0)
FROM usage_ledger
GROUP BY 1, 2, 3, 4, 5`

// hasUsageLedgerDailyCapabilities 检查汇总表与三条触发器的实际定义是否完全就绪。
func hasUsageLedgerDailyCapabilities(ctx context.Context, connection *sql.Conn) (bool, error) {
	tableReady, storedTriggers, err := inspectUsageLedgerDailyState(ctx, connection)
	if err != nil || !tableReady {
		return false, err
	}
	for name, expected := range expectedLedgerDailyTriggers {
		actual, ok := storedTriggers[name]
		if !ok || actual != expected {
			return false, nil
		}
	}
	return true, nil
}

// ensureUsageLedgerDaily 仅在汇总表或触发器能力缺失/不一致时安装脚本并执行一次性对齐回填。
//
// 日常 CLI 或服务打开已就绪数据库时直接跳过，避免每次启动扫描明细账本。
func ensureUsageLedgerDaily(ctx context.Context, connection *sql.Conn) error {
	tableReady, storedTriggers, err := inspectUsageLedgerDailyState(ctx, connection)
	if err != nil {
		return err
	}
	allTriggersMatch := tableReady
	for name, expected := range expectedLedgerDailyTriggers {
		if actual, ok := storedTriggers[name]; !ok || actual != expected {
			allTriggersMatch = false
			break
		}
	}
	if allTriggersMatch {
		return nil
	}

	// 重建派生行会丢失未知扩展列的逐桶值；遇到此类结构应明确拒绝而不是清空 peer 数据。
	if tableReady {
		columns, err := readTableColumnSet(ctx, connection, "usage_ledger_daily")
		if err != nil {
			return err
		}
		known := make(map[string]bool, len(requiredTableColumns["usage_ledger_daily"]))
		for _, name := range requiredTableColumns["usage_ledger_daily"] {
			known[name] = true
		}
		for name := range columns {
			if !known[name] {
				return fmt.Errorf("%w: cannot rebuild usage_ledger_daily with unknown column=%s", ErrIncompatibleDatabase, name)
			}
		}
	}

	// 既有正确的 usage_ledger_daily_after_insert 原地保留；仅当历史遗留版本定义不同步时才替换。
	if actualInsert, exists := storedTriggers[triggerNameLedgerDailyAfterInsert]; exists &&
		actualInsert != expectedLedgerDailyTriggers[triggerNameLedgerDailyAfterInsert] {
		if _, err := connection.ExecContext(
			ctx,
			"DROP TRIGGER IF EXISTS "+triggerNameLedgerDailyAfterInsert,
		); err != nil {
			return fmt.Errorf("移除旧版 %s 触发器失败: %w", triggerNameLedgerDailyAfterInsert, err)
		}
	}

	if _, err := connection.ExecContext(ctx, SchemaUsageLedgerDailySQL); err != nil {
		return fmt.Errorf("安装 usage_ledger_daily 结构与触发器失败: %w", err)
	}

	var hasData bool
	if err := connection.QueryRowContext(
		ctx,
		`SELECT EXISTS(SELECT 1 FROM usage_ledger LIMIT 1)
		     OR EXISTS(SELECT 1 FROM usage_ledger_daily LIMIT 1)`,
	).Scan(&hasData); err != nil {
		return fmt.Errorf("检查 usage_ledger 数据非空状态失败: %w", err)
	}
	if !hasData {
		return nil
	}

	if _, err := connection.ExecContext(ctx, "DELETE FROM usage_ledger_daily"); err != nil {
		return fmt.Errorf("清空待重算的 usage_ledger_daily 失败: %w", err)
	}
	if _, err := connection.ExecContext(ctx, reconcileUsageLedgerDailyInsertSQL); err != nil {
		return fmt.Errorf("从 usage_ledger 重建日汇总失败: %w", err)
	}
	return nil
}

func inspectUsageLedgerDailyState(
	ctx context.Context,
	connection *sql.Conn,
) (bool, map[string]string, error) {
	var tableExists int
	if err := connection.QueryRowContext(
		ctx,
		"SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'usage_ledger_daily'",
	).Scan(&tableExists); err != nil {
		return false, nil, fmt.Errorf("检查 usage_ledger_daily 表存在性失败: %w", err)
	}
	tableReady := false
	if tableExists == 1 {
		columns, err := readTableColumnSet(ctx, connection, "usage_ledger_daily")
		if err != nil {
			return false, nil, err
		}
		tableReady = hasRequiredColumnSubset(columns, requiredTableColumns["usage_ledger_daily"])
	}

	rows, err := connection.QueryContext(
		ctx,
		`SELECT name, COALESCE(sql, '')
		   FROM sqlite_schema
		  WHERE type = 'trigger' AND tbl_name = 'usage_ledger'`,
	)
	if err != nil {
		return false, nil, fmt.Errorf("读取 usage_ledger 触发器定义失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()

	triggers := make(map[string]string, 3)
	for rows.Next() {
		var name, rawSQL string
		if err := rows.Scan(&name, &rawSQL); err != nil {
			return false, nil, fmt.Errorf("解析 usage_ledger 触发器定义失败: %w", err)
		}
		triggers[name] = canonicalizeTriggerSQL(rawSQL)
	}
	if err := rows.Err(); err != nil {
		return false, nil, fmt.Errorf("遍历 usage_ledger 触发器定义失败: %w", err)
	}
	return tableReady, triggers, rows.Close()
}

// canonicalizeTriggerSQL 把无字符串字面量的触发器 DDL 规整为与缩进、注释及 IF NOT EXISTS 无关的稳定串。
func canonicalizeTriggerSQL(raw string) string {
	var stripped strings.Builder
	stripped.Grow(len(raw))
	for line := range strings.SplitSeq(raw, "\n") {
		if idx := strings.Index(line, "--"); idx >= 0 {
			line = line[:idx]
		}
		stripped.WriteString(line)
		stripped.WriteByte(' ')
	}

	clean := stripped.String()
	var spaced strings.Builder
	spaced.Grow(len(clean) + 32)
	for i := 0; i < len(clean); i++ {
		ch := clean[i]
		switch ch {
		case '(', ')', ',', ';':
			spaced.WriteByte(' ')
			spaced.WriteByte(ch)
			spaced.WriteByte(' ')
		case '\r', '\n', '\t':
			spaced.WriteByte(' ')
		default:
			spaced.WriteByte(ch)
		}
	}

	normalized := strings.ToLower(strings.Join(strings.Fields(spaced.String()), " "))
	normalized = strings.TrimSuffix(normalized, " ;")
	normalized = strings.TrimSuffix(normalized, ";")
	normalized = strings.TrimSpace(normalized)
	normalized = strings.Replace(
		normalized,
		"create trigger if not exists ",
		"create trigger ",
		1,
	)
	normalized = strings.Replace(
		normalized,
		" on usage_ledger for each row ",
		" on usage_ledger ",
		1,
	)
	return normalized
}
