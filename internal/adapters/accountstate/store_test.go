package accountstate

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	_ "modernc.org/sqlite"
)

const (
	testRef  = "acct_0123456789abcdef0123"
	otherRef = "acct_ffffffffffffffffffff"
	codexRef = "acct_22222222222222222222"
)

// TestSchemaMatchesNodeAccountState 锁住列顺序与主键：Node 的 exact-schema
// 校验按位置比对，任何列顺序变化都必须在这里先变红。
func TestSchemaMatchesNodeAccountState(t *testing.T) {
	want := []string{
		"account_ref",
		"provider",
		"status",
		"configured",
		"api_key_mode",
		"auth_mode",
		"runtime_state",
		"remaining_pct",
		"display_name",
		"updated_at",
	}
	if got := ExpectedColumns(); !slices.Equal(got, want) {
		t.Fatalf("ExpectedColumns() = %v, want %v", got, want)
	}

	_, db := newTestStore(t)
	rows, err := db.Query("PRAGMA table_info(account_state)")
	if err != nil {
		t.Fatalf("PRAGMA table_info: %v", err)
	}
	defer func() {
		_ = rows.Close()
	}()
	columns := make([]string, 0, len(want))
	primaryKey := make([]string, 0, 1)
	for rows.Next() {
		var (
			position   int64
			name       string
			columnType string
			notNull    int64
			defaultVal any
			pkOrder    int64
		)
		if err := rows.Scan(&position, &name, &columnType, &notNull, &defaultVal, &pkOrder); err != nil {
			t.Fatalf("读取列定义: %v", err)
		}
		columns = append(columns, name)
		if pkOrder > 0 {
			primaryKey = append(primaryKey, name)
		}
	}
	if !slices.Equal(columns, want) {
		t.Fatalf("account_state 列 = %v, want %v", columns, want)
	}
	if !slices.Equal(primaryKey, []string{"account_ref"}) {
		t.Fatalf("account_state 主键 = %v, want [account_ref]", primaryKey)
	}
}

// TestOpenRequiresNodeDatabaseAndExactSchema 验证 Go 不代 Node 建库，也不接受
// 任何列顺序漂移。
func TestOpenRequiresNodeDatabaseAndExactSchema(t *testing.T) {
	ctx := context.Background()
	if _, err := Open(ctx, t.TempDir()); !errors.Is(err, ErrDatabaseMissing) {
		t.Fatalf("Open(空数据根) error = %v, want ErrDatabaseMissing", err)
	}

	root := t.TempDir()
	databasePath := filepath.Join(root, appstate.DatabaseFileName)
	db := openRawDatabase(t, databasePath)
	mustExec(t, db, "CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)")
	_ = db.Close()
	if _, err := Open(ctx, root); !errors.Is(err, ErrSchemaInvalid) {
		t.Fatalf("Open(缺 account_state) error = %v, want ErrSchemaInvalid", err)
	}

	if err := os.Remove(databasePath); err != nil {
		t.Fatalf("移除测试库: %v", err)
	}
	db = openRawDatabase(t, databasePath)
	mustExec(t, db, `CREATE TABLE account_state (
		provider TEXT NOT NULL,
		account_ref TEXT PRIMARY KEY,
		status TEXT NOT NULL DEFAULT 'up',
		configured INTEGER NOT NULL DEFAULT 0,
		api_key_mode INTEGER NOT NULL DEFAULT 0,
		auth_mode TEXT,
		runtime_state TEXT,
		remaining_pct REAL,
		display_name TEXT,
		updated_at INTEGER NOT NULL
	)`)
	_ = db.Close()
	if _, err := Open(ctx, root); !errors.Is(err, ErrSchemaInvalid) {
		t.Fatalf("Open(列顺序漂移) error = %v, want ErrSchemaInvalid", err)
	}
}

// TestOpenReadsAndWritesAppStateDatabase 走真实数据根，验证 Open 的落点与写入闭环。
func TestOpenReadsAndWritesAppStateDatabase(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	db := openRawDatabase(t, filepath.Join(root, appstate.DatabaseFileName))
	mustExec(t, db, `CREATE TABLE account_refs (
		account_ref TEXT PRIMARY KEY,
		provider TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	)`)
	if err := EnsureSchema(ctx, db); err != nil {
		t.Fatalf("EnsureSchema: %v", err)
	}
	mustExec(t, db, "INSERT INTO account_refs VALUES (?, 'claude', 1, 1)", testRef)
	_ = db.Close()

	store, err := Open(ctx, root)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() {
		_ = store.Close()
	}()
	displayName := "Main"
	if _, err := store.Upsert(ctx, UpsertInput{
		AccountRef: testRef, Provider: "claude", Configured: true, DisplayName: &displayName,
	}); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	projection, found, err := store.Project(ctx, testRef)
	if err != nil || !found {
		t.Fatalf("Project() found=%v err=%v", found, err)
	}
	if projection.Status != StatusUp || !projection.Configured || projection.DisplayName != "Main" {
		t.Fatalf("Projection = %+v", projection)
	}
}

// TestUpsertMirrorsNodeCoalesceSemantics 逐条覆盖 Node upsertAccountState 的
// 空值语义，避免「显式空串」被当成「未提供」。
func TestUpsertMirrorsNodeCoalesceSemantics(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()
	store.now = func() time.Time { return time.UnixMilli(1000) }

	displayName := "  Main  "
	remaining := 120.0
	changed, err := store.Upsert(ctx, UpsertInput{
		AccountRef: testRef, Provider: " Claude ", Configured: true,
		DisplayName: &displayName, RemainingPct: &remaining,
	})
	if err != nil || !changed {
		t.Fatalf("首次 Upsert() = %v, %v", changed, err)
	}
	state, found, err := store.Get(ctx, testRef)
	if err != nil || !found {
		t.Fatalf("Get() found=%v err=%v", found, err)
	}
	if state.Status != StatusUp || state.Provider != "claude" || state.DisplayName != "Main" {
		t.Fatalf("首次投影 = %+v", state)
	}
	if state.RemainingPct == nil || *state.RemainingPct != 100 {
		t.Fatalf("remainingPct 未截到 100: %+v", state.RemainingPct)
	}
	if state.AuthMode != "" || state.APIKeyMode || !state.Configured || state.UpdatedAtMS != 1000 {
		t.Fatalf("首次投影默认值错误: %+v", state)
	}

	// 省略 status/displayName 时保留旧值；remainingPct 显式省略会覆盖为 NULL。
	store.now = func() time.Time { return time.UnixMilli(2000) }
	authMode := "oauth"
	if _, err := store.Upsert(ctx, UpsertInput{
		AccountRef: testRef, Provider: "claude", Status: pointer("DOWN"),
		AuthMode: &authMode, Configured: true,
	}); err != nil {
		t.Fatalf("第二次 Upsert: %v", err)
	}
	state, _, err = store.Get(ctx, testRef)
	if err != nil {
		t.Fatalf("第二次 Get: %v", err)
	}
	if state.Status != StatusDown || state.DisplayName != "Main" || state.AuthMode != "oauth" {
		t.Fatalf("合并语义错误: %+v", state)
	}
	if state.RemainingPct != nil {
		t.Fatalf("remainingPct 应被覆盖为 NULL: %+v", state.RemainingPct)
	}

	// 显式空 displayName 清空；显式空 authMode 在 Node 语义里是 null，保留旧值。
	empty := ""
	if _, err := store.Upsert(ctx, UpsertInput{
		AccountRef: testRef, Provider: "claude", DisplayName: &empty, AuthMode: &empty, Configured: true,
	}); err != nil {
		t.Fatalf("第三次 Upsert: %v", err)
	}
	state, _, err = store.Get(ctx, testRef)
	if err != nil {
		t.Fatalf("第三次 Get: %v", err)
	}
	if state.DisplayName != "" || state.AuthMode != "oauth" || state.Status != StatusDown {
		t.Fatalf("空值语义错误: %+v", state)
	}
	if state.UpdatedAtMS != 2000 {
		t.Fatalf("updatedAt = %d, want 2000", state.UpdatedAtMS)
	}
}

// TestUpsertNeverWritesRuntimeState 守住分工：runtime_state 仍归 Node 迁移期兜底。
func TestUpsertNeverWritesRuntimeState(t *testing.T) {
	store, db := newTestStore(t)
	ctx := context.Background()
	if _, err := store.Upsert(ctx, UpsertInput{AccountRef: testRef, Provider: "claude"}); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	const runtimeState = `{"kind":"cooldown"}`
	mustExec(t, db, "UPDATE account_state SET runtime_state = ? WHERE account_ref = ?", runtimeState, testRef)

	displayName := "Renamed"
	if _, err := store.Upsert(ctx, UpsertInput{
		AccountRef: testRef, Provider: "claude", DisplayName: &displayName,
	}); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	var stored sql.NullString
	if err := db.QueryRow(
		"SELECT runtime_state FROM account_state WHERE account_ref = ?", testRef,
	).Scan(&stored); err != nil {
		t.Fatalf("读取 runtime_state: %v", err)
	}
	if !stored.Valid || stored.String != runtimeState {
		t.Fatalf("runtime_state = %q, want %q", stored.String, runtimeState)
	}
}

// TestSetStatusUpdatesOnlyLifecycleColumns 对齐 Node setStatus：只动 status 与
// updated_at，且不新增行。
func TestSetStatusUpdatesOnlyLifecycleColumns(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()
	displayName := "Main"
	if _, err := store.Upsert(ctx, UpsertInput{
		AccountRef: testRef, Provider: "claude", Configured: true, DisplayName: &displayName,
	}); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	store.now = func() time.Time { return time.UnixMilli(5000) }

	changed, err := store.SetStatus(ctx, testRef, "disabled")
	if err != nil || !changed {
		t.Fatalf("SetStatus() = %v, %v", changed, err)
	}
	state, _, err := store.Get(ctx, testRef)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if state.Status != StatusDown || state.UpdatedAtMS != 5000 {
		t.Fatalf("状态未更新: %+v", state)
	}
	if state.DisplayName != "Main" || !state.Configured {
		t.Fatalf("SetStatus 改动了非生命周期列: %+v", state)
	}

	changed, err = store.SetStatus(ctx, otherRef, "down")
	if err != nil || changed {
		t.Fatalf("SetStatus(无投影行) = %v, %v; want false, nil", changed, err)
	}
	if _, err := store.SetStatus(ctx, testRef, "paused"); !errors.Is(err, ErrInvalidStatus) {
		t.Fatalf("SetStatus(无效状态) error = %v, want ErrInvalidStatus", err)
	}
}

// TestProjectionExposesStatusResponseFields 锁住响应键集合：新增字段必须是
// 明确的合同变更，而不是顺手带出 Node 独有词汇。
func TestProjectionExposesStatusResponseFields(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()
	displayName := "Main"
	if _, err := store.Upsert(ctx, UpsertInput{
		AccountRef: testRef, Provider: "claude", Configured: true, DisplayName: &displayName,
	}); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	projection, found, err := store.Project(ctx, testRef)
	if err != nil || !found {
		t.Fatalf("Project() found=%v err=%v", found, err)
	}
	payload, err := json.Marshal(projection)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	keys := make([]string, 0, len(decoded))
	for key := range decoded {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	if want := []string{"accountRef", "configured", "displayName", "provider", "status"}; !slices.Equal(keys, want) {
		t.Fatalf("投影键 = %v, want %v", keys, want)
	}
	if decoded["status"] != StatusUp || decoded["configured"] != true || decoded["displayName"] != "Main" {
		t.Fatalf("投影值 = %v", decoded)
	}
	if _, found, err := store.Project(ctx, otherRef); err != nil || found {
		t.Fatalf("Project(缺失) found=%v err=%v", found, err)
	}
}

// TestListFiltersProviderAndOrdersByUpdatedAt 对齐 Node listStates 的过滤与排序。
func TestListFiltersProviderAndOrdersByUpdatedAt(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()
	upsertAt := func(ref, provider string, updatedAtMS int64) {
		t.Helper()
		store.now = func() time.Time { return time.UnixMilli(updatedAtMS) }
		if _, err := store.Upsert(ctx, UpsertInput{AccountRef: ref, Provider: provider}); err != nil {
			t.Fatalf("Upsert(%s): %v", ref, err)
		}
	}
	upsertAt(testRef, "claude", 1000)
	upsertAt(codexRef, "codex", 2000)
	upsertAt(otherRef, "claude", 3000)

	states, err := store.List(ctx, "claude")
	if err != nil {
		t.Fatalf("List(claude): %v", err)
	}
	refs := make([]string, 0, len(states))
	for _, state := range states {
		refs = append(refs, state.AccountRef)
	}
	if want := []string{otherRef, testRef}; !slices.Equal(refs, want) {
		t.Fatalf("List(claude) = %v, want %v", refs, want)
	}

	states, err = store.List(ctx, "CODEX")
	if err != nil {
		t.Fatalf("List(codex): %v", err)
	}
	if len(states) != 1 || states[0].AccountRef != codexRef {
		t.Fatalf("List(codex) = %+v", states)
	}
	if _, err := store.List(ctx, "  "); !errors.Is(err, ErrInvalidProvider) {
		t.Fatalf("List(空 Provider) error = %v, want ErrInvalidProvider", err)
	}
}

// TestUpsertRejectsInvalidInputsAndUnknownAccounts 覆盖校验顺序与外键等价行为。
func TestUpsertRejectsInvalidInputsAndUnknownAccounts(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()
	if _, err := store.Upsert(ctx, UpsertInput{
		AccountRef: "not-a-ref", Provider: "claude",
	}); !errors.Is(err, accountcore.ErrInvalidAccountRef) {
		t.Fatalf("无效账号引用 error = %v, want ErrInvalidAccountRef", err)
	}
	if _, err := store.Upsert(ctx, UpsertInput{AccountRef: testRef}); !errors.Is(err, ErrInvalidProvider) {
		t.Fatalf("空 Provider error = %v, want ErrInvalidProvider", err)
	}
	if _, err := store.Upsert(ctx, UpsertInput{
		AccountRef: testRef, Provider: "claude", Status: pointer("paused"),
	}); !errors.Is(err, ErrInvalidStatus) {
		t.Fatalf("无效状态 error = %v, want ErrInvalidStatus", err)
	}
	const unknownRef = "acct_33333333333333333333"
	if _, err := store.Upsert(ctx, UpsertInput{
		AccountRef: unknownRef, Provider: "claude",
	}); !errors.Is(err, ErrAccountUnknown) {
		t.Fatalf("台账缺失 error = %v, want ErrAccountUnknown", err)
	}
	if _, found, err := store.Get(ctx, unknownRef); err != nil || found {
		t.Fatalf("Get(台账外账号) found=%v err=%v", found, err)
	}
}

func newTestStore(t *testing.T) (*Store, *sql.DB) {
	t.Helper()
	db := openRawDatabase(t, filepath.Join(t.TempDir(), appstate.DatabaseFileName))
	mustExec(t, db, `CREATE TABLE account_refs (
		account_ref TEXT PRIMARY KEY,
		provider TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	)`)
	ctx := context.Background()
	if err := EnsureSchema(ctx, db); err != nil {
		t.Fatalf("EnsureSchema: %v", err)
	}
	for _, account := range []struct {
		ref      string
		provider string
	}{
		{testRef, "claude"},
		{otherRef, "claude"},
		{codexRef, "codex"},
	} {
		mustExec(t, db, "INSERT INTO account_refs VALUES (?, ?, 1, 1)", account.ref, account.provider)
	}
	store, err := OpenDatabase(ctx, db)
	if err != nil {
		t.Fatalf("OpenDatabase: %v", err)
	}
	return store, db
}

func openRawDatabase(t *testing.T, databasePath string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatalf("打开测试库: %v", err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() {
		_ = db.Close()
	})
	return db
}

func mustExec(t *testing.T, db *sql.DB, statement string, args ...any) {
	t.Helper()
	if _, err := db.Exec(statement, args...); err != nil {
		t.Fatalf("执行 %q: %v", statement, err)
	}
}

func pointer[T any](value T) *T {
	return &value
}

// TestEnsureAccountRefAndPruneMissing 覆盖台账兜底写入与按 Provider 清理过期投影。
func TestEnsureAccountRefAndPruneMissing(t *testing.T) {
	store, db := newTestStore(t)
	ctx := context.Background()
	const newRef = "acct_44444444444444444444"

	if err := store.EnsureAccountRef(ctx, newRef, "CODEX"); err != nil {
		t.Fatalf("EnsureAccountRef() error = %v", err)
	}
	if _, err := store.Upsert(ctx, UpsertInput{AccountRef: newRef, Provider: "codex", Configured: true}); err != nil {
		t.Fatalf("Upsert after EnsureAccountRef error = %v", err)
	}
	if _, err := store.Upsert(ctx, UpsertInput{AccountRef: codexRef, Provider: "codex", Configured: true}); err != nil {
		t.Fatalf("Upsert(codexRef) error = %v", err)
	}
	if _, err := store.Upsert(ctx, UpsertInput{AccountRef: testRef, Provider: "claude", Configured: true}); err != nil {
		t.Fatalf("Upsert(testRef) error = %v", err)
	}

	var storedProvider string
	if err := db.QueryRow("SELECT provider FROM account_refs WHERE account_ref = ?", newRef).Scan(&storedProvider); err != nil {
		t.Fatalf("读取 account_refs 失败: %v", err)
	}
	if storedProvider != "codex" {
		t.Fatalf("provider = %q, want codex", storedProvider)
	}

	removed, err := store.PruneMissing(ctx, "CODEX", []string{newRef, "invalid-ignored"})
	if err != nil {
		t.Fatalf("PruneMissing() error = %v", err)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}

	codexStates, err := store.List(ctx, "codex")
	if err != nil {
		t.Fatalf("List(codex) error = %v", err)
	}
	if len(codexStates) != 1 || codexStates[0].AccountRef != newRef {
		t.Fatalf("List(codex) = %+v, want only %s", codexStates, newRef)
	}
	claudeStates, err := store.List(ctx, "claude")
	if err != nil {
		t.Fatalf("List(claude) error = %v", err)
	}
	if len(claudeStates) != 1 || claudeStates[0].AccountRef != testRef {
		t.Fatalf("claude state should not be pruned: %+v", claudeStates)
	}

	if err := store.EnsureAccountRef(ctx, "bad-ref", "codex"); !errors.Is(err, accountcore.ErrInvalidAccountRef) {
		t.Fatalf("EnsureAccountRef(bad-ref) = %v, want ErrInvalidAccountRef", err)
	}
	if err := store.EnsureAccountRef(ctx, newRef, " "); !errors.Is(err, ErrInvalidProvider) {
		t.Fatalf("EnsureAccountRef(empty provider) = %v, want ErrInvalidProvider", err)
	}
	if _, err := store.PruneMissing(ctx, " ", nil); !errors.Is(err, ErrInvalidProvider) {
		t.Fatalf("PruneMissing(empty provider) = %v, want ErrInvalidProvider", err)
	}
}
