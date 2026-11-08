package webuiaccountsapi

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

// newBareDatabase 建一个「只有部分表」的库，用于验证缺表时的 fail-soft。
func newBareDatabase(t *testing.T, statements ...string) string {
	t.Helper()
	directory := t.TempDir()
	database, err := sql.Open("sqlite", "file:"+filepath.Join(directory, databaseFileName)+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	for _, statement := range statements {
		if _, err := database.Exec(statement); err != nil {
			t.Fatalf("Exec(%s) error = %v", statement, err)
		}
	}
	if err := database.Close(); err != nil {
		t.Fatalf("database.Close() error = %v", err)
	}
	return directory
}

const bareAccountsDDL = "CREATE TABLE accounts (" +
	"account_ref TEXT NOT NULL PRIMARY KEY," +
	"provider_id TEXT NOT NULL," +
	"cli_account_id INTEGER NOT NULL," +
	"enabled INTEGER NOT NULL DEFAULT 1," +
	"created_at_ms INTEGER NOT NULL," +
	"updated_at_ms INTEGER NOT NULL)"

// 缺表不是错误：其它表缺失时对应列退化成默认值，行照常返回。
func TestListAccountRowsFailSoftOnMissingTables(t *testing.T) {
	directory := newBareDatabase(t,
		bareAccountsDDL,
		"INSERT INTO accounts (account_ref, provider_id, cli_account_id, enabled, created_at_ms, updated_at_ms) VALUES ('"+oauthAccountRef+"', 'codex', 1, 1, 7, 9)",
	)
	source := newTestSource(t, directory)
	handler := newTestHandler(t, source)

	response, decoded := requestJSON(t, handler, "")
	if response.Code != 200 {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	rows := accountRows(t, decoded)
	if len(rows) != 1 {
		t.Fatalf("行数 = %d, 期望 1", len(rows))
	}
	row := rows[0]
	if row["provider"] != "codex" || row["accountRef"] != oauthAccountRef || row["displayId"] != "1" {
		t.Fatalf("基础列不符: %#v", row)
	}
	if row["enabled"] != true {
		t.Fatalf("enabled 应取自 accounts.enabled: %#v", row)
	}
	if row["configured"] != false || row["planType"] != "pending" || row["modelCount"] != float64(0) {
		t.Fatalf("缺表时应退化成默认值: %#v", row)
	}
	if row["updatedAt"] != float64(9) {
		t.Fatalf("updatedAt = %v, 期望账号行更新时间 9", row["updatedAt"])
	}
	warnings := stringSlice(t, decoded["warnings"])
	for _, table := range []string{
		"account_credentials",
		"account_ui_state",
		"account_profiles",
		"account_usage_snapshots",
		"account_defaults",
		"account_models",
	} {
		if !containsString(warnings, "missing_table:"+table) {
			t.Fatalf("warnings 缺少 %s: %v", table, warnings)
		}
	}
	if containsString(warnings, "missing_table:accounts") {
		t.Fatalf("accounts 存在却报了缺表: %v", warnings)
	}
}

// 连账号表都没有时返回空页 + 告警，而不是 500：调用方按「没有账号」渲染。
func TestListAccountRowsWithoutAccountsTable(t *testing.T) {
	directory := newBareDatabase(t,
		"CREATE TABLE account_models (account_ref TEXT NOT NULL, model_id TEXT NOT NULL, upstream_available INTEGER NOT NULL DEFAULT 0, manual_policy TEXT NOT NULL DEFAULT 'inherit', updated_at_ms INTEGER NOT NULL, PRIMARY KEY (account_ref, model_id))",
	)
	source := newTestSource(t, directory)

	result, err := source.ListAccountRows(context.Background(), Query{Limit: 10})
	if err != nil {
		t.Fatalf("ListAccountRows() error = %v", err)
	}
	if len(result.Rows) != 0 {
		t.Fatalf("行数 = %d, 期望 0", len(result.Rows))
	}
	found := false
	for _, table := range result.MissingTables {
		if table == tableAccounts {
			found = true
		}
	}
	if !found {
		t.Fatalf("MissingTables 未包含 accounts: %v", result.MissingTables)
	}

	handler := newTestHandler(t, source)
	response, decoded := requestJSON(t, handler, "")
	if response.Code != 200 {
		t.Fatalf("status = %d, 期望 200", response.Code)
	}
	if len(accountRows(t, decoded)) != 0 {
		t.Fatal("没有账号表时必须返回空数组")
	}
}

// 只读连接必须真的只读：写语句要当场失败，避免读模型改到业务库。
func TestSQLiteSourceIsReadOnly(t *testing.T) {
	source := newTestSource(t, newSeededDatabase(t))
	if _, err := source.db.Exec("DELETE FROM accounts"); err == nil {
		t.Fatal("只读连接上的 DELETE 必须失败")
	}
}

// 三份字段清单必须恰好覆盖 Row 的全部 JSON 键，且互不重叠。
//
// 这条守卫是为了防止「给 Row 加了字段，但忘了归类」：那种字段会静默从契约里消失。
func TestRowFieldListsCoverEveryJSONKey(t *testing.T) {
	fields := allRowFields()
	if len(fields) == 0 {
		t.Fatal("Row 没有解析出任何 JSON 键")
	}
	seen := map[string]string{}
	for _, group := range []struct {
		name  string
		items []string
	}{
		{"filled", filledRowFields},
		{"approx", approxRowFields},
		{"unfilled", unfilledRowFields()},
	} {
		for _, field := range group.items {
			if previous, duplicated := seen[field]; duplicated {
				t.Fatalf("字段 %s 同时出现在 %s 与 %s", field, previous, group.name)
			}
			seen[field] = group.name
		}
	}
	for _, field := range fields {
		if _, classified := seen[field]; !classified {
			t.Fatalf("字段 %s 没有被任何清单覆盖", field)
		}
	}
	if len(seen) != len(fields) {
		t.Fatalf("清单字段数 %d != Row 键数 %d", len(seen), len(fields))
	}
	// 抽样固定分类：这三项是对拍脚本的判据，改动必须先改脚本。
	for field, want := range map[string]string{
		"enabled":    "filled",
		"modelCount": "filled",
		"updatedAt":  "approx",
		"status":     "unfilled",
	} {
		if seen[field] != want {
			t.Fatalf("字段 %s 归在 %s, 期望 %s", field, seen[field], want)
		}
	}
}

func stringSlice(t *testing.T, value any) []string {
	t.Helper()
	raw, ok := value.([]any)
	if !ok {
		t.Fatalf("warnings 不是数组: %#v", value)
	}
	items := make([]string, 0, len(raw))
	for _, entry := range raw {
		items = append(items, strings.TrimSpace(entry.(string)))
	}
	return items
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
