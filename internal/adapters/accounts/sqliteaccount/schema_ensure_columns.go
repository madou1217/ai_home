package sqliteaccount

import (
	"context"
	"database/sql"
	"fmt"
)

// additiveColumnSpec 描述既有历史表缺失某一已知列时的幂等补列规则与一次性派生语句。
type additiveColumnSpec struct {
	column  string
	alter   string
	postAdd string
}

type tableAdditiveSpec struct {
	table   string
	columns []additiveColumnSpec
}

// knownAdditiveColumns 覆盖历史表结构演进中曾通过增量补齐引入的全部列与默认值/约束。
//
// 重要不变量：
//   - account_credentials 缺 credential_ref（早期表）时仅用 ADD COLUMN + 按 account_ref 派生
//     'cred_' || substr(account_ref, 6)，绝不 DROP/重建表，也不解析或改写 credential_json；
//   - account_profiles 缺 workspace_id 时仅在新增该列的当次事务内从 Codex profile_json
//     一次性提取 $.account_id，已有 workspace_id 列时绝不覆盖既有值。
var knownAdditiveColumns = []tableAdditiveSpec{
	{
		table: "account_credentials",
		columns: []additiveColumnSpec{
			{
				column: "credential_ref",
				alter: `ALTER TABLE account_credentials
					ADD COLUMN credential_ref TEXT NOT NULL DEFAULT 'cred_00000000000000000000'
					CHECK (
						length(credential_ref) = 25
						AND substr(credential_ref, 1, 5) = 'cred_'
						AND substr(credential_ref, 6) NOT GLOB '*[^0-9a-f]*'
					)`,
				postAdd: `UPDATE account_credentials
					SET credential_ref = 'cred_' || substr(account_ref, 6)`,
			},
		},
	},
	{
		table: "account_profiles",
		columns: []additiveColumnSpec{
			{
				column: "workspace_id",
				alter: `ALTER TABLE account_profiles
					ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''
					CHECK (length(workspace_id) <= 256)`,
				postAdd: `UPDATE account_profiles
					SET workspace_id = COALESCE(json_extract(profile_json, '$.account_id'), '')
					WHERE workspace_id = ''
					  AND account_ref IN (SELECT account_ref FROM accounts WHERE provider_id = 'codex')
					  AND json_type(profile_json, '$.account_id') = 'text'
					  AND length(json_extract(profile_json, '$.account_id')) <= 256`,
			},
		},
	},
	{
		table: "account_usage",
		columns: []additiveColumnSpec{
			{
				column: "plan_type",
				alter: `ALTER TABLE account_usage
					ADD COLUMN plan_type TEXT NOT NULL DEFAULT ''
					CHECK (length(plan_type) <= 64)`,
			},
		},
	},
	{
		table: "usage_ledger",
		columns: []additiveColumnSpec{
			{
				column: "source_key",
				alter:  `ALTER TABLE usage_ledger ADD COLUMN source_key TEXT NOT NULL DEFAULT ''`,
			},
			{
				column: "quota_bucket",
				alter:  `ALTER TABLE usage_ledger ADD COLUMN quota_bucket TEXT NOT NULL DEFAULT ''`,
			},
		},
	},
	{
		table: "account_usage_snapshots",
		columns: []additiveColumnSpec{
			{
				column: "quota_status",
				alter: `ALTER TABLE account_usage_snapshots
					ADD COLUMN quota_status TEXT NOT NULL DEFAULT ''
					CHECK (quota_status IN ('', 'available', 'exhausted', 'pending', 'not_applicable'))`,
			},
			{
				column: "quota_reason",
				alter: `ALTER TABLE account_usage_snapshots
					ADD COLUMN quota_reason TEXT NOT NULL DEFAULT ''
					CHECK (length(quota_reason) <= 128)`,
			},
			{
				column: "remaining_bps",
				alter: `ALTER TABLE account_usage_snapshots
					ADD COLUMN remaining_bps INTEGER
					CHECK (remaining_bps IS NULL OR remaining_bps BETWEEN 0 AND 10000)`,
			},
			{
				column: "has_numeric_remaining",
				alter: `ALTER TABLE account_usage_snapshots
					ADD COLUMN has_numeric_remaining INTEGER NOT NULL DEFAULT 0
					CHECK (has_numeric_remaining IN (0, 1))`,
			},
		},
	},
	{
		table: "account_ui_state",
		columns: []additiveColumnSpec{
			{
				column: "configured",
				alter: `ALTER TABLE account_ui_state
					ADD COLUMN configured INTEGER NOT NULL DEFAULT 0
					CHECK (configured IN (0, 1))`,
			},
			{
				column: "oauth_pending",
				alter: `ALTER TABLE account_ui_state
					ADD COLUMN oauth_pending INTEGER NOT NULL DEFAULT 0
					CHECK (oauth_pending IN (0, 1))`,
			},
		},
	},
	{
		table: "oauth_jobs",
		columns: []additiveColumnSpec{
			{
				column: "account_ref",
				alter: `ALTER TABLE oauth_jobs
					ADD COLUMN account_ref TEXT NOT NULL DEFAULT ''
					CHECK (length(account_ref) <= 128)`,
			},
			{
				column: "cli_account_id",
				alter: `ALTER TABLE oauth_jobs
					ADD COLUMN cli_account_id INTEGER NOT NULL DEFAULT 0
					CHECK (cli_account_id >= 0)`,
			},
			{
				column: "finished_at_ms",
				alter: `ALTER TABLE oauth_jobs
					ADD COLUMN finished_at_ms INTEGER NOT NULL DEFAULT 0
					CHECK (finished_at_ms BETWEEN 0 AND 253402300799999)`,
			},
			{
				column: "owner",
				alter: `ALTER TABLE oauth_jobs
					ADD COLUMN owner TEXT NOT NULL DEFAULT 'go'
					CHECK (owner IN ('go', 'node'))`,
			},
			{
				column: "source",
				alter: `ALTER TABLE oauth_jobs
					ADD COLUMN source TEXT NOT NULL DEFAULT 'go'
					CHECK (source IN ('go', 'node'))`,
			},
		},
	},
	{
		table: "model_alias",
		columns: []additiveColumnSpec{
			{
				column: "display_models_json",
				alter:  `ALTER TABLE model_alias ADD COLUMN display_models_json TEXT NOT NULL DEFAULT '[]'`,
			},
		},
	},
}

// ensureMissingColumns 检查既有表列集合，仅对确实缺失的列执行增量补齐与一次性回填。
func ensureMissingColumns(ctx context.Context, connection *sql.Conn) error {
	for _, tableSpec := range knownAdditiveColumns {
		present, err := readTableColumnSet(ctx, connection, tableSpec.table)
		if err != nil {
			return err
		}
		for _, colSpec := range tableSpec.columns {
			if _, exists := present[colSpec.column]; exists {
				continue
			}
			if _, err := connection.ExecContext(ctx, colSpec.alter); err != nil {
				return fmt.Errorf(
					"为表 %s 补齐列 %s 失败: %w",
					tableSpec.table,
					colSpec.column,
					err,
				)
			}
			if colSpec.postAdd != "" {
				if _, err := connection.ExecContext(ctx, colSpec.postAdd); err != nil {
					return fmt.Errorf(
						"回填表 %s 新增列 %s 失败: %w",
						tableSpec.table,
						colSpec.column,
						err,
					)
				}
			}
			present[colSpec.column] = struct{}{}
		}
	}
	return nil
}
