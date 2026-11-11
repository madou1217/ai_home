package webuiaccountsapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

// 两个账号的固定事实：一个 OAuth（全字段），一个 API Key（额度/身份缺省）。
const (
	oauthAccountRef  = "acct_0123456789abcdef0123"
	apiKeyAccountRef = "acct_0123456789abcdef0456"

	oauthUpdatedAtMS  = int64(1700000000000)
	oauthCapturedAtMS = int64(1793937685487)
	apiKeyUpdatedAtMS = int64(1700000000500)
	apiKeyCapturedMS  = int64(1793937000000)
)

type allowAuthorizer bool

func (authorizer allowAuthorizer) Authorized(*http.Request) bool { return bool(authorizer) }

// newSeededDatabase 用真实 schema 建库再灌两个账号。
//
// 为什么不自己写一份建表 SQL：读模型查的是线上那套表，测试库必须由
// sqliteaccount.Open 的迁移生成，否则改表结构时测试只会「继续绿」。
func newSeededDatabase(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	store, err := sqliteaccount.Open(context.Background(), sqliteaccount.OpenOptions{
		AIHomeDir: directory,
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("sqliteaccount.Open() error = %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("store.Close() error = %v", err)
	}
	database := openWritableDatabase(t, directory)
	seedAccounts(t, database)
	return directory
}

// openWritableDatabase 用可写连接灌数据；被测代码用的是另一条只读连接。
func openWritableDatabase(t *testing.T, directory string) *sql.DB {
	t.Helper()
	database, err := sql.Open("sqlite", "file:"+filepath.Join(directory, databaseFileName)+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	database.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = database.Close() })
	return database
}

func mustExec(t *testing.T, database *sql.DB, statement string, arguments ...any) {
	t.Helper()
	if _, err := database.Exec(statement, arguments...); err != nil {
		t.Fatalf("Exec(%s) error = %v", statement, err)
	}
}

func seedAccounts(t *testing.T, database *sql.DB) {
	t.Helper()
	mustExec(t, database,
		"INSERT INTO accounts (account_ref, provider_id, cli_account_id, enabled, created_at_ms, updated_at_ms) VALUES (?, 'codex', 1, 1, ?, ?)",
		oauthAccountRef, oauthUpdatedAtMS, oauthUpdatedAtMS)
	mustExec(t, database,
		"INSERT INTO accounts (account_ref, provider_id, cli_account_id, enabled, created_at_ms, updated_at_ms) VALUES (?, 'claude', 7, 1, ?, ?)",
		apiKeyAccountRef, apiKeyUpdatedAtMS, apiKeyUpdatedAtMS)

	mustExec(t, database,
		"INSERT INTO account_credentials (account_ref, credential_ref, auth_kind, auth_mode, format_version, credential_json, updated_at_ms) VALUES (?, ?, 'oauth', 'consumer', 1, '{}', ?)",
		oauthAccountRef, "cred_0123456789abcdef0123", oauthUpdatedAtMS)
	mustExec(t, database,
		"INSERT INTO account_credentials (account_ref, credential_ref, auth_kind, auth_mode, format_version, credential_json, updated_at_ms) VALUES (?, ?, 'api_key', '', 1, '{}', ?)",
		apiKeyAccountRef, "cred_0123456789abcdef0456", apiKeyUpdatedAtMS)

	// 账号 1：ui_state 的展示名优先于 profiles 的展示名；账号 2：两者都为空。
	mustExec(t, database,
		"INSERT INTO account_ui_state (account_ref, status, display_name, auth_mode, api_key_mode, base_url, updated_at_ms, configured, oauth_pending) VALUES (?, 'up', '工作号', 'oauth', 0, '', ?, 1, 0)",
		oauthAccountRef, oauthUpdatedAtMS)
	mustExec(t, database,
		"INSERT INTO account_ui_state (account_ref, status, display_name, auth_mode, api_key_mode, base_url, updated_at_ms, configured, oauth_pending) VALUES (?, 'up', '', 'api-key', 1, 'https://proxy.example.com', ?, 1, 0)",
		apiKeyAccountRef, apiKeyUpdatedAtMS)

	mustExec(t, database,
		"INSERT INTO account_profiles (account_ref, display_name, email, subscription_kind, subscription_raw, format_version, profile_json, updated_at_ms) VALUES (?, 'profile 名', 'a@example.com', 'plus', 'plus', 1, '{}', ?)",
		oauthAccountRef, oauthUpdatedAtMS)

	mustExec(t, database,
		"INSERT INTO account_usage_snapshots (account_ref, provider_id, kind, source, captured_at_ms, payload_json, quota_status, quota_reason, remaining_bps, has_numeric_remaining) VALUES (?, 'codex', '', '', ?, '{}', 'available', '', 7350, 1)",
		oauthAccountRef, oauthCapturedAtMS)
	mustExec(t, database,
		"INSERT INTO account_usage_snapshots (account_ref, provider_id, kind, source, captured_at_ms, payload_json, quota_status, quota_reason, remaining_bps, has_numeric_remaining) VALUES (?, 'claude', '', '', ?, '{}', 'exhausted', 'window_exhausted', 0, 0)",
		apiKeyAccountRef, apiKeyCapturedMS)

	mustExec(t, database,
		"INSERT INTO account_defaults (provider_id, account_ref, updated_at_ms) VALUES ('codex', ?, ?)",
		oauthAccountRef, oauthUpdatedAtMS)

	// 账号 1 三个模型里两个有效（inherit+可用、force_enable），账号 2 那条上游不可用。
	mustExec(t, database, "INSERT INTO account_models (account_ref, model_id, upstream_available, manual_policy, updated_at_ms) VALUES (?, 'gpt-5', 1, 'inherit', ?)", oauthAccountRef, oauthUpdatedAtMS)
	mustExec(t, database, "INSERT INTO account_models (account_ref, model_id, upstream_available, manual_policy, updated_at_ms) VALUES (?, 'gpt-5-mini', 0, 'force_enable', ?)", oauthAccountRef, oauthUpdatedAtMS)
	mustExec(t, database, "INSERT INTO account_models (account_ref, model_id, upstream_available, manual_policy, updated_at_ms) VALUES (?, 'gpt-5-nano', 0, 'inherit', ?)", oauthAccountRef, oauthUpdatedAtMS)
	mustExec(t, database, "INSERT INTO account_models (account_ref, model_id, upstream_available, manual_policy, updated_at_ms) VALUES (?, 'claude-sonnet', 0, 'inherit', ?)", apiKeyAccountRef, apiKeyUpdatedAtMS)
}

func newTestHandler(t *testing.T, source Source) *Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{Authorizer: allowAuthorizer(true), Source: source})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func newTestSource(t *testing.T, directory string) *SQLiteSource {
	t.Helper()
	source, err := OpenSQLiteSource(SQLiteOptions{AIHomeDir: directory})
	if err != nil {
		t.Fatalf("OpenSQLiteSource() error = %v", err)
	}
	t.Cleanup(func() { _ = source.Close() })
	return source
}

// requestJSON 发一次 GET 并把响应解码成「保留键存在性的通用结构」。
func requestJSON(t *testing.T, handler http.Handler, rawQuery string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	target := Path
	if rawQuery != "" {
		target += "?" + rawQuery
	}
	request := httptest.NewRequest(http.MethodGet, target, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	decoded := map[string]any{}
	if err := json.Unmarshal(response.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("响应不是合法 JSON: %v body=%s", err, response.Body.String())
	}
	return response, decoded
}

func accountRows(t *testing.T, decoded map[string]any) []map[string]any {
	t.Helper()
	raw, ok := decoded["accounts"].([]any)
	if !ok {
		t.Fatalf("accounts 不是数组: %#v", decoded["accounts"])
	}
	rows := make([]map[string]any, 0, len(raw))
	for _, entry := range raw {
		row, ok := entry.(map[string]any)
		if !ok {
			t.Fatalf("账号行不是对象: %#v", entry)
		}
		rows = append(rows, row)
	}
	return rows
}

// 逐字段断言：读模型的每个键都必须有确定的值或明确的空占位。
func TestListAccountRowsFillsStaticFields(t *testing.T) {
	source := newTestSource(t, newSeededDatabase(t))
	handler := newTestHandler(t, source)

	response, decoded := requestJSON(t, handler, "")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if decoded["ok"] != true {
		t.Fatalf("ok = %v", decoded["ok"])
	}
	if decoded["derived_by"] != derivedByGoPartial {
		t.Fatalf("derived_by = %v", decoded["derived_by"])
	}
	rows := accountRows(t, decoded)
	if len(rows) != 2 {
		t.Fatalf("行数 = %d, 期望 2", len(rows))
	}

	oauth := rows[0]
	wantOAuth := map[string]any{
		"provider":               "codex",
		"accountRef":             oauthAccountRef,
		"displayId":              "1",
		"status":                 "",
		"displayName":            "工作号",
		"configured":             true,
		"apiKeyMode":             false,
		"isDefault":              true,
		"isMobile":               false,
		"remainingPct":           73.5,
		"updatedAt":              float64(oauthCapturedAtMS),
		"planType":               "plus",
		"email":                  "a@example.com",
		"authMode":               "oauth",
		"authPending":            false,
		"baseUrl":                "",
		"quotaStatus":            "available",
		"tokenUsageSource":       "",
		"gatewayTargetSupported": false,
		"modelCount":             float64(2),
	}
	for field, want := range wantOAuth {
		got, present := oauth[field]
		if !present {
			t.Fatalf("账号 1 缺少字段 %s", field)
		}
		if got != want {
			t.Fatalf("账号 1 字段 %s = %#v, 期望 %#v", field, got, want)
		}
	}
	// 条件字段为空时按 Node 的习惯省略，不产出假键。
	for _, field := range []string{"planName", "region", "zcodeRegion", "loginType", "lastUsedAt", "runtimeStatus", "quotaReason"} {
		if _, present := oauth[field]; present {
			t.Fatalf("账号 1 不该出现空的条件字段 %s", field)
		}
	}
	// 空占位必须是形状正确的空值，而不是 null。
	for _, field := range []string{"upstreamErrorRules", "upstreamErrorGroupIds", "displayNames", "activityActions"} {
		value, present := oauth[field].([]any)
		if !present || len(value) != 0 {
			t.Fatalf("账号 1 字段 %s 应为空数组, 实际 %#v", field, oauth[field])
		}
	}
	// 这里的快照 payload 是空对象「{}」：按无快照下发 null，而不是让前端拿到空壳对象。
	if oauth["usageSnapshot"] != nil || oauth["tokenUsage"] != nil {
		t.Fatalf("账号 1 的 usageSnapshot/tokenUsage 应为 null: %#v %#v", oauth["usageSnapshot"], oauth["tokenUsage"])
	}

	apiKey := rows[1]
	wantAPIKey := map[string]any{
		"provider":     "claude",
		"accountRef":   apiKeyAccountRef,
		"displayId":    "7",
		"displayName":  "",
		"configured":   true,
		"apiKeyMode":   true,
		"isDefault":    false,
		"remainingPct": nil,
		"updatedAt":    float64(apiKeyUpdatedAtMS),
		"planType":     "api-key",
		"email":        "",
		"authMode":     "api-key",
		"baseUrl":      "https://proxy.example.com",
		"quotaStatus":  "exhausted",
		"quotaReason":  "window_exhausted",
		"modelCount":   float64(0),
	}
	for field, want := range wantAPIKey {
		got, present := apiKey[field]
		if !present {
			t.Fatalf("账号 2 缺少字段 %s", field)
		}
		if got != want {
			t.Fatalf("账号 2 字段 %s = %#v, 期望 %#v", field, got, want)
		}
	}
}

// 额度快照的 payload_json 必须整份解析成对象下发，账号页才有窗口/剩余额度可渲染；
// 坏文档只让该行退化为 null，不能把整页打成 500。
func TestListAccountRowsParsesUsageSnapshotPayload(t *testing.T) {
	directory := newSeededDatabase(t)
	database := openWritableDatabase(t, directory)
	// 形状照抄真实快照文档（agy 的 payload 就是这样：account + capturedAt + entries/models）。
	validPayload := `{"capturedAt":1793937685487,"kind":"codex_usage",` +
		`"account":{"email":"a@example.com","planType":"plus"},` +
		`"entries":[{"bucket":"5h","remainingPct":73.5,"resetAtMs":1793939000000}]}`
	mustExec(t, database,
		"UPDATE account_usage_snapshots SET payload_json = ? WHERE account_ref = ?",
		validPayload, oauthAccountRef)
	// 真实 schema 对 payload_json 有 json_valid CHECK，脏快照只可能来自旧库或绕过写的
	// 外部工具；这里临时放开约束造出那种行，验证读模型对坏数据仍然 fail-soft。
	mustExec(t, database, "PRAGMA ignore_check_constraints = ON")
	mustExec(t, database,
		"UPDATE account_usage_snapshots SET payload_json = ? WHERE account_ref = ?",
		`{"kind":`, apiKeyAccountRef)

	source := newTestSource(t, directory)
	handler := newTestHandler(t, source)

	response, decoded := requestJSON(t, handler, "")
	if response.Code != http.StatusOK {
		t.Fatalf("坏快照不能把列表打成 500: status = %d body=%s", response.Code, response.Body.String())
	}
	rows := accountRows(t, decoded)
	if len(rows) != 2 {
		t.Fatalf("行数 = %d, 期望 2", len(rows))
	}

	snapshot, ok := rows[0]["usageSnapshot"].(map[string]any)
	if !ok {
		t.Fatalf("账号 1 的 usageSnapshot 不是对象: %#v", rows[0]["usageSnapshot"])
	}
	if snapshot["capturedAt"] != float64(1793937685487) || snapshot["kind"] != "codex_usage" {
		t.Fatalf("快照顶层字段不符: %#v", snapshot)
	}
	account, ok := snapshot["account"].(map[string]any)
	if !ok || account["email"] != "a@example.com" {
		t.Fatalf("快照 account 未原样透出: %#v", snapshot["account"])
	}
	entries, ok := snapshot["entries"].([]any)
	if !ok || len(entries) != 1 {
		t.Fatalf("快照 entries 未原样透出: %#v", snapshot["entries"])
	}
	entry, _ := entries[0].(map[string]any)
	if entry["remainingPct"] != 73.5 || entry["resetAtMs"] != float64(1793939000000) {
		t.Fatalf("快照窗口字段不符: %#v", entry)
	}

	if rows[1]["usageSnapshot"] != nil {
		t.Fatalf("坏 JSON 的账号快照应为 null: %#v", rows[1]["usageSnapshot"])
	}
}

// agy 的原始 payload 是 models[] 型：Go 必须按前端契约补出 entryShape/label 等字段，
// 否则账号页拿到的是探针原文（没有 label、顺序也没归一）。
func TestListAccountRowsNormalizesAgyUsageSnapshot(t *testing.T) {
	directory := newSeededDatabase(t)
	database := openWritableDatabase(t, directory)
	const agyPayload = `{"schemaVersion":2,"kind":"agy_code_assist_quota",` +
		`"source":"agy_fetch_available_models","capturedAt":1793937685487,` +
		`"account":{"email":"agy@example.com","planType":"pro","subscriptionTier":"Google AI Pro","project":"proj-1"},` +
		`"models":[` +
		`{"model":"claude-sonnet-4-5","displayName":"Claude Sonnet 4.5","remainingPct":81.5,"resetIn":"2h","resetAtMs":1793940000000,"supportsThinking":true,"maxTokens":200000},` +
		`{"model":"gemini-2.5-pro","displayName":"Gemini 2.5 Pro","remainingPct":42.5,"resetIn":"4h","resetAtMs":1793950000000}` +
		`]}`
	mustExec(t, database,
		"UPDATE account_usage_snapshots SET payload_json = ? WHERE account_ref = ?",
		agyPayload, oauthAccountRef)

	source := newTestSource(t, directory)
	handler := newTestHandler(t, source)
	response, decoded := requestJSON(t, handler, "")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	rows := accountRows(t, decoded)
	snapshot, ok := rows[0]["usageSnapshot"].(map[string]any)
	if !ok {
		t.Fatalf("agy 的 usageSnapshot 不是对象: %#v", rows[0]["usageSnapshot"])
	}
	if snapshot["entryShape"] != entryShapeModels {
		t.Fatalf("entryShape = %v, 期望 %s", snapshot["entryShape"], entryShapeModels)
	}
	// 顶层事实原样保留（账号页的套餐/邮箱展示依赖它）。
	account, ok := snapshot["account"].(map[string]any)
	if !ok || account["email"] != "agy@example.com" {
		t.Fatalf("快照 account 未保留: %#v", snapshot["account"])
	}
	models, ok := snapshot["models"].([]any)
	if !ok || len(models) != 2 {
		t.Fatalf("models 未归一为两条: %#v", snapshot["models"])
	}
	// 同窗口长度（模型型没有窗口声明）按剩余额度升序：最紧的在前。
	first, _ := models[0].(map[string]any)
	if first["model"] != "gemini-2.5-pro" || first["label"] != "gemini-2.5-pro" {
		t.Fatalf("首个模型未按契约归一: %#v", first)
	}
	if first["remainingPct"] != 42.5 || first["resetAtMs"] != float64(1793950000000) {
		t.Fatalf("模型剩余额度/重置时间不符: %#v", first)
	}
	second, _ := models[1].(map[string]any)
	if second["displayName"] != "Claude Sonnet 4.5" || second["supportsThinking"] != true {
		t.Fatalf("模型能力字段被丢弃: %#v", second)
	}
	if second["maxOutputTokens"] != nil {
		t.Fatalf("原始文档没有 maxOutputTokens 时不该造键: %#v", second)
	}
}

// entries[] 型（window / bucket）走同一条归一：主额度按窗口升序、gift 排最后并保留旁路标记。
func TestListAccountRowsNormalizesEntriesUsageSnapshot(t *testing.T) {
	directory := newSeededDatabase(t)
	database := openWritableDatabase(t, directory)
	const entriesPayload = `{"schemaVersion":2,"kind":"kimi_oauth_usage","capturedAt":1793937685487,` +
		`"account":{"planType":"allegro"},"entries":[` +
		`{"bucket":"gift:Invite to Earn Credit","remainingPct":0,"category":"gift","resetAtMs":1793939000000},` +
		`{"bucket":"monthly","windowMinutes":43200,"remainingPct":55,"resetAtMs":1796939000000},` +
		`{"bucket":"five_hour","window":"5h","windowMinutes":300,"remainingPct":91,"resetAtMs":1793941000000}` +
		`]}`
	mustExec(t, database,
		"UPDATE account_usage_snapshots SET payload_json = ? WHERE account_ref = ?",
		entriesPayload, oauthAccountRef)

	source := newTestSource(t, directory)
	handler := newTestHandler(t, source)
	response, decoded := requestJSON(t, handler, "")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	snapshot, ok := accountRows(t, decoded)[0]["usageSnapshot"].(map[string]any)
	if !ok {
		t.Fatalf("usageSnapshot 不是对象: %#v", accountRows(t, decoded)[0]["usageSnapshot"])
	}
	if snapshot["entryShape"] != entryShapeBucket {
		t.Fatalf("entryShape = %v, 期望 %s", snapshot["entryShape"], entryShapeBucket)
	}
	entries, ok := snapshot["entries"].([]any)
	if !ok || len(entries) != 3 {
		t.Fatalf("entries 未归一: %#v", snapshot["entries"])
	}
	first, _ := entries[0].(map[string]any)
	if first["bucket"] != "five_hour" || first["label"] != "5h" || first["windowMinutes"] != float64(300) {
		t.Fatalf("窗口条目未按契约归一: %#v", first)
	}
	second, _ := entries[1].(map[string]any)
	if second["bucket"] != "monthly" || second["label"] != "Monthly" {
		t.Fatalf("具名/通用桶标签不符: %#v", second)
	}
	gift, _ := entries[2].(map[string]any)
	if gift["category"] != "gift" || gift["label"] != "Invite to Earn Credit" {
		t.Fatalf("赠送条目未保留旁路标记或标签: %#v", gift)
	}
	if gift["windowMinutes"] != float64(0) || gift["remainingPct"] != float64(0) {
		t.Fatalf("赠送条目字段不符: %#v", gift)
	}
}

// 未知 provider / 未知形状必须原样降级：不 panic、不 500，也不凭空造 entryShape。
func TestListAccountRowsDegradesUnknownUsageSnapshot(t *testing.T) {
	directory := newSeededDatabase(t)
	database := openWritableDatabase(t, directory)
	const unknownPayload = `{"kind":"mystery_quota","capturedAt":1793937685487,` +
		`"account":{"email":"mystery@example.com"},"mysteryField":{"nested":true},"windows":"not-an-array"}`
	mustExec(t, database,
		"UPDATE account_usage_snapshots SET payload_json = ? WHERE account_ref = ?",
		unknownPayload, oauthAccountRef)

	source := newTestSource(t, directory)
	handler := newTestHandler(t, source)
	response, decoded := requestJSON(t, handler, "")
	if response.Code != http.StatusOK {
		t.Fatalf("未知形状不能把列表打成 500: status = %d body=%s", response.Code, response.Body.String())
	}
	rows := accountRows(t, decoded)
	snapshot, ok := rows[0]["usageSnapshot"].(map[string]any)
	if !ok {
		t.Fatalf("未知形状应原样下发对象: %#v", rows[0]["usageSnapshot"])
	}
	if snapshot["kind"] != "mystery_quota" || snapshot["capturedAt"] != float64(1793937685487) {
		t.Fatalf("未知形状的原始字段被改动: %#v", snapshot)
	}
	if _, exists := snapshot["entryShape"]; exists {
		t.Fatalf("未知形状不该编造 entryShape: %#v", snapshot)
	}
	mystery, ok := snapshot["mysteryField"].(map[string]any)
	if !ok || mystery["nested"] != true {
		t.Fatalf("未知字段未原样保留: %#v", snapshot["mysteryField"])
	}
}

// 过滤与分页必须与 accountsapi 同口径：provider/ref 精确过滤，after_ref 为 keyset 游标。
func TestListAccountRowsFiltersAndPaginates(t *testing.T) {
	source := newTestSource(t, newSeededDatabase(t))
	handler := newTestHandler(t, source)

	_, filtered := requestJSON(t, handler, "provider=CODEX")
	rows := accountRows(t, filtered)
	if len(rows) != 1 || rows[0]["accountRef"] != oauthAccountRef {
		t.Fatalf("provider 过滤结果不符: %#v", rows)
	}

	_, byRef := requestJSON(t, handler, "ref="+apiKeyAccountRef)
	rows = accountRows(t, byRef)
	if len(rows) != 1 || rows[0]["provider"] != "claude" {
		t.Fatalf("ref 过滤结果不符: %#v", rows)
	}

	_, firstPage := requestJSON(t, handler, "limit=1")
	rows = accountRows(t, firstPage)
	if len(rows) != 1 || rows[0]["accountRef"] != oauthAccountRef {
		t.Fatalf("第一页不符: %#v", rows)
	}
	page, ok := firstPage["page"].(map[string]any)
	if !ok || page["has_more"] != true || page["next_after_ref"] != oauthAccountRef {
		t.Fatalf("分页信息不符: %#v", firstPage["page"])
	}

	_, secondPage := requestJSON(t, handler, "limit=1&after_ref="+oauthAccountRef)
	rows = accountRows(t, secondPage)
	if len(rows) != 1 || rows[0]["accountRef"] != apiKeyAccountRef {
		t.Fatalf("第二页不符: %#v", rows)
	}
	page, _ = secondPage["page"].(map[string]any)
	if page["has_more"] != false || page["next_after_ref"] != "" {
		t.Fatalf("第二页分页信息不符: %#v", page)
	}
}

func TestHandlerRejectsInvalidRequests(t *testing.T) {
	source := newTestSource(t, newSeededDatabase(t))
	handler := newTestHandler(t, source)

	cases := []struct {
		name  string
		query string
	}{
		{"未知参数", "unknown=1"},
		{"游标非法", "after_ref=acct_zzz"},
		{"ref 非法", "ref=1"},
		{"limit 越界", "limit=0"},
		{"limit 非数字", "limit=many"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			response, decoded := requestJSON(t, handler, testCase.query)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, 期望 400", response.Code)
			}
			errorBody, _ := decoded["error"].(map[string]any)
			if errorBody["code"] != "invalid_query" {
				t.Fatalf("error.code = %v", errorBody["code"])
			}
		})
	}

	t.Run("方法不允许", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, Path, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusMethodNotAllowed {
			t.Fatalf("status = %d, 期望 405", response.Code)
		}
	})

	t.Run("未授权", func(t *testing.T) {
		denied, err := NewHandler(Dependencies{Authorizer: allowAuthorizer(false), Source: source})
		if err != nil {
			t.Fatalf("NewHandler() error = %v", err)
		}
		request := httptest.NewRequest(http.MethodGet, Path, nil)
		response := httptest.NewRecorder()
		denied.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, 期望 401", response.Code)
		}
	})

	t.Run("缺依赖", func(t *testing.T) {
		if _, err := NewHandler(Dependencies{}); err == nil {
			t.Fatal("缺依赖时必须报错")
		}
	})
}

func TestOpenSQLiteSourceRejectsMissingDatabase(t *testing.T) {
	if _, err := OpenSQLiteSource(SQLiteOptions{AIHomeDir: t.TempDir()}); err == nil {
		t.Fatal("数据库不存在时必须报错，不能创建空库")
	}
	if _, err := OpenSQLiteSource(SQLiteOptions{}); err == nil {
		t.Fatal("空数据目录必须报错")
	}
}
