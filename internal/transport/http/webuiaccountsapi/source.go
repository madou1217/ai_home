package webuiaccountsapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

const (
	// databaseFileName 是 AIH 单一业务数据库的固定文件名（与 sqliteaccount.DatabaseFileName 同一份）。
	// 这里只读不写，所以不 import adapter 包，避免传输层依赖存储实现。
	databaseFileName = "aih.db"
)

// ErrInvalidOptions 表示数据源缺少可用的数据目录。
var ErrInvalidOptions = errors.New("账号页读模型数据源参数无效")

// ErrSourceUnavailable 表示只读连接尚未就绪或已关闭，Handler 据此回 503 而不是空页。
var ErrSourceUnavailable = errors.New("账号页读模型数据库不可用")

// Query 是账号页行的稳定游标查询。
//
// Limit 由调用方传「可见条数 + 1」：多取一行用于判断 has_more，与 accountsapi 同口径。
type Query struct {
	// Provider 是 provider_id 精确过滤（已小写去空白），空串表示不过滤。
	Provider string
	// AccountRef 是单账号精确过滤，空串表示不过滤。
	AccountRef string
	// AfterRef 是 keyset 游标：只返回 account_ref 大于它的行。
	AfterRef string
	Limit    int
}

// IsValid 判断查询是否落在有界稳定游标范围内。
func (query Query) IsValid() bool {
	return query.Limit >= 1
}

// Result 是读模型的一页结果。
type Result struct {
	Rows []Row
	// MissingTables 是 fail-soft 时缺失的表名，按固定顺序排列。
	MissingTables []string
}

// Warnings 把缺表情况翻译成响应里的降级说明。
func (result Result) Warnings() []string {
	if len(result.MissingTables) == 0 {
		return nil
	}
	warnings := make([]string, 0, len(result.MissingTables))
	for _, table := range result.MissingTables {
		warnings = append(warnings, "missing_table:"+table)
	}
	return warnings
}

// Source 是账号页读模型的数据端口。
type Source interface {
	ListAccountRows(ctx context.Context, query Query) (Result, error)
}

// 读模型按表拼 SQL：缺哪张表就把对应列换成默认值，而不是整条查询失败。
const (
	tableAccounts    = "accounts"
	tableCredentials = "account_credentials"
	tableUIState     = "account_ui_state"
	tableProfiles    = "account_profiles"
	tableSnapshots   = "account_usage_snapshots"
	tableDefaults    = "account_defaults"
	tableModels      = "account_models"
)

// trackedTables 是读模型关心的全部表：accounts 缺失时整页为空，
// 其余表缺失只让对应列退化成默认值并记 warning。
var trackedTables = []string{
	tableAccounts,
	tableCredentials,
	tableUIState,
	tableProfiles,
	tableSnapshots,
	tableDefaults,
	tableModels,
}

// SQLiteOptions 是打开只读数据源的依赖。
type SQLiteOptions struct {
	// AIHomeDir 是 AIH 数据根目录；数据库固定为该目录下的 aih.db。
	AIHomeDir string
}

// SQLiteSource 是 aih.db 的只读实现。
//
// 为什么单独开一条只读连接而不是复用账号 Store：读模型只需要 SELECT，
// 独立连接让「读不动就降级」与写事务完全隔离，也不需要给 Store 开新访问器。
type SQLiteSource struct {
	db *sql.DB
}

// OpenSQLiteSource 打开只读数据源。数据库文件不存在时直接报错——
// 这里绝不创建空库：空库会让上层以为「没有账号」，而不是「还没初始化」。
func OpenSQLiteSource(options SQLiteOptions) (*SQLiteSource, error) {
	directory := strings.TrimSpace(options.AIHomeDir)
	if directory == "" {
		return nil, ErrInvalidOptions
	}
	databasePath := filepath.Join(directory, databaseFileName)
	if _, err := os.Stat(databasePath); err != nil {
		return nil, fmt.Errorf("读取账号页读模型数据库失败: %w", err)
	}
	database, err := sql.Open("sqlite", readOnlyDSN(databasePath))
	if err != nil {
		return nil, fmt.Errorf("打开账号页读模型数据库失败: %w", err)
	}
	// 读模型只做短查询；连接数压到 2，避免和账号写连接抢 SQLite 的写锁。
	database.SetMaxOpenConns(2)
	database.SetMaxIdleConns(2)
	return &SQLiteSource{db: database}, nil
}

// Close 释放只读连接池。
func (source *SQLiteSource) Close() error {
	if source == nil || source.db == nil {
		return nil
	}
	return source.db.Close()
}

// readOnlyDSN 固定开启只读语义：query_only 让误写的语句也改不动库。
func readOnlyDSN(databasePath string) string {
	fileURL := &url.URL{Scheme: "file", Path: filepath.ToSlash(databasePath)}
	query := fileURL.Query()
	query.Add("_pragma", "busy_timeout(5000)")
	query.Add("_pragma", "query_only(1)")
	fileURL.RawQuery = query.Encode()
	return fileURL.String()
}

// ListAccountRows 读取一页账号页行；缺表等可降级情况通过 Result.MissingTables 表达，不返回 error。
func (source *SQLiteSource) ListAccountRows(ctx context.Context, query Query) (Result, error) {
	if source == nil || source.db == nil {
		return Result{}, ErrSourceUnavailable
	}
	if !query.IsValid() {
		return Result{}, ErrInvalidQuery
	}
	available, err := source.readTables(ctx)
	if err != nil {
		return Result{}, err
	}
	missing := missingTables(available)
	if !available[tableAccounts] {
		// 没有账号表就是没有行；这不是错误，调用方按空页处理。
		return Result{Rows: []Row{}, MissingTables: missing}, nil
	}
	statement, arguments := buildRowStatement(available, query)
	rows, err := source.db.QueryContext(ctx, statement, arguments...)
	if err != nil {
		return Result{}, fmt.Errorf("查询账号页行失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()
	result := Result{Rows: make([]Row, 0, query.Limit), MissingTables: missing}
	for rows.Next() {
		fact, err := scanAccountFact(rows)
		if err != nil {
			return Result{}, err
		}
		result.Rows = append(result.Rows, newRow(fact))
	}
	if err := rows.Err(); err != nil {
		return Result{}, fmt.Errorf("遍历账号页行失败: %w", err)
	}
	return result, nil
}

// readTables 一次性读出库里实际存在的表，用于 fail-soft 拼 SQL。
func (source *SQLiteSource) readTables(ctx context.Context) (map[string]bool, error) {
	rows, err := source.db.QueryContext(ctx, "SELECT name FROM sqlite_master WHERE type = 'table'")
	if err != nil {
		return nil, fmt.Errorf("读取账号页读模型表清单失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()
	available := make(map[string]bool, len(trackedTables))
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("读取账号页读模型表清单失败: %w", err)
		}
		available[name] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("读取账号页读模型表清单失败: %w", err)
	}
	return available, nil
}

// missingTables 按固定顺序列出缺失的表，保证响应可重放。
func missingTables(available map[string]bool) []string {
	missing := make([]string, 0, len(trackedTables))
	for _, table := range trackedTables {
		if !available[table] {
			missing = append(missing, table)
		}
	}
	return missing
}

// buildRowStatement 拼出一条 LEFT JOIN 等价的查询。
//
// 为什么用相关子查询而不是 LEFT JOIN：每张可选表的连接键都是主键，子查询是 O(1)；
// 而缺表时只要把整段表达式换成字面量，不需要同时删 join 和改 COALESCE。
func buildRowStatement(available map[string]bool, query Query) (string, []any) {
	columns := []string{
		"a.account_ref",
		"a.provider_id",
		"a.cli_account_id",
		"a.enabled",
		"a.updated_at_ms",
		optionalColumn(available, tableCredentials,
			"COALESCE((SELECT 1 FROM account_credentials AS c WHERE c.account_ref = a.account_ref LIMIT 1), 0)", "0"),
		optionalColumn(available, tableUIState,
			"COALESCE((SELECT u.display_name FROM account_ui_state AS u WHERE u.account_ref = a.account_ref), '')", "''"),
		optionalColumn(available, tableUIState,
			"COALESCE((SELECT u.auth_mode FROM account_ui_state AS u WHERE u.account_ref = a.account_ref), '')", "''"),
		optionalColumn(available, tableUIState,
			"COALESCE((SELECT u.api_key_mode FROM account_ui_state AS u WHERE u.account_ref = a.account_ref), 0)", "0"),
		optionalColumn(available, tableUIState,
			"COALESCE((SELECT u.oauth_pending FROM account_ui_state AS u WHERE u.account_ref = a.account_ref), 0)", "0"),
		optionalColumn(available, tableUIState,
			"COALESCE((SELECT u.base_url FROM account_ui_state AS u WHERE u.account_ref = a.account_ref), '')", "''"),
		optionalColumn(available, tableProfiles,
			"COALESCE((SELECT p.display_name FROM account_profiles AS p WHERE p.account_ref = a.account_ref), '')", "''"),
		// 资料表没有 email 时回落凭据里的 email：agy 是凭据带 email、资料表缺失
		// （2026-11-11 用 Go 登录的账号就是这样），账号页因此显示不出邮箱。
		optionalColumn(available, tableProfiles,
			"COALESCE(NULLIF((SELECT p.email FROM account_profiles AS p WHERE p.account_ref = a.account_ref), ''), "+
				optionalColumn(available, tableCredentials,
					"(SELECT CASE WHEN json_valid(c.credential_json) THEN json_extract(c.credential_json, '$.email') END"+
						" FROM account_credentials AS c WHERE c.account_ref = a.account_ref)",
					"''")+
				", '')", "''"),
		optionalColumn(available, tableProfiles,
			"COALESCE((SELECT p.subscription_kind FROM account_profiles AS p WHERE p.account_ref = a.account_ref), '')", "''"),
		optionalColumn(available, tableSnapshots,
			"COALESCE((SELECT s.quota_status FROM account_usage_snapshots AS s WHERE s.account_ref = a.account_ref), '')", "''"),
		optionalColumn(available, tableSnapshots,
			"COALESCE((SELECT s.quota_reason FROM account_usage_snapshots AS s WHERE s.account_ref = a.account_ref), '')", "''"),
		optionalColumn(available, tableSnapshots,
			"COALESCE((SELECT s.remaining_bps FROM account_usage_snapshots AS s WHERE s.account_ref = a.account_ref), 0)", "0"),
		optionalColumn(available, tableSnapshots,
			"COALESCE((SELECT s.has_numeric_remaining FROM account_usage_snapshots AS s WHERE s.account_ref = a.account_ref), 0)", "0"),
		optionalColumn(available, tableSnapshots,
			"COALESCE((SELECT s.captured_at_ms FROM account_usage_snapshots AS s WHERE s.account_ref = a.account_ref), 0)", "0"),
		optionalColumn(available, tableDefaults,
			"COALESCE((SELECT 1 FROM account_defaults AS d WHERE d.provider_id = a.provider_id AND d.account_ref = a.account_ref LIMIT 1), 0)", "0"),
		optionalColumn(available, tableModels,
			"(SELECT COUNT(*) FROM account_models AS m WHERE m.account_ref = a.account_ref"+
				" AND (m.manual_policy = 'force_enable'"+
				" OR (m.manual_policy = 'inherit' AND m.upstream_available = 1)))", "0"),
	}
	conditions := []string{"a.account_ref > ?"}
	arguments := []any{query.AfterRef}
	if query.Provider != "" {
		conditions = append(conditions, "a.provider_id = ?")
		arguments = append(arguments, query.Provider)
	}
	if query.AccountRef != "" {
		conditions = append(conditions, "a.account_ref = ?")
		arguments = append(arguments, query.AccountRef)
	}
	arguments = append(arguments, query.Limit)
	statement := "SELECT\n  " + strings.Join(columns, ",\n  ") +
		"\nFROM accounts AS a\nWHERE " + strings.Join(conditions, " AND ") +
		"\nORDER BY a.account_ref\nLIMIT ?"
	return statement, arguments
}

// optionalColumn 在表存在时用真实表达式，缺表时退化成字面量默认值。
func optionalColumn(available map[string]bool, table, expression, fallback string) string {
	if available[table] {
		return expression
	}
	return fallback
}

func scanAccountFact(rows *sql.Rows) (accountFact, error) {
	var fact accountFact
	err := rows.Scan(
		&fact.AccountRef,
		&fact.Provider,
		&fact.CLIAccountID,
		&fact.Enabled,
		&fact.UpdatedAtMS,
		&fact.HasCredential,
		&fact.UIDisplayName,
		&fact.UIAuthMode,
		&fact.UIAPIKeyMode,
		&fact.UIOAuthPending,
		&fact.UIBaseURL,
		&fact.ProfileName,
		&fact.ProfileEmail,
		&fact.Subscription,
		&fact.QuotaStatus,
		&fact.QuotaReason,
		&fact.RemainingBPS,
		&fact.HasRemaining,
		&fact.CapturedAtMS,
		&fact.IsDefault,
		&fact.ModelCount,
	)
	if err != nil {
		return accountFact{}, fmt.Errorf("读取账号页行失败: %w", err)
	}
	return fact, nil
}
