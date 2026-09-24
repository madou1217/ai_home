package sqliteaccount

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

// TestOpenMigratesV5AndBackfillsCodexWorkspace 保证既有 v5 库升级后 Codex 工作区成为公开列，
// 且账号管理投影无需读取 profile_json 就能返回与 Node 一致的工作区。
func TestOpenMigratesV5AndBackfillsCodexWorkspace(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	aiHomeDir := t.TempDir()
	v5 := openRawSQLite(t, filepath.Join(aiHomeDir, DatabaseFileName))
	for version, migration := range []string{SchemaV1, SchemaV2, SchemaV3, SchemaV4, SchemaV5} {
		if _, err := v5.ExecContext(ctx, migration); err != nil {
			t.Fatalf("apply raw schema v%d error = %v", version+1, err)
		}
	}
	nowMS := time.Date(2026, time.September, 24, 0, 0, 0, 0, time.UTC).UnixMilli()
	rows := []struct {
		ref, provider string
		cli           int
		profileJSON   string
	}{
		{"acct_aaaaaaaaaaaaaaaaaaaa", "codex", 1, `{"user_id":"u-team","account_id":"ws-team","is_fedramp":false}`},
		{"acct_bbbbbbbbbbbbbbbbbbbb", "codex", 2, `{"user_id":"u-me","account_id":"personal","is_fedramp":false}`},
		{"acct_cccccccccccccccccccc", "claude", 1, `{"account_id":"not-a-codex-workspace"}`},
	}
	for _, row := range rows {
		if _, err := v5.ExecContext(ctx, `INSERT INTO accounts (account_ref, provider_id, cli_account_id, enabled, created_at_ms, updated_at_ms) VALUES (?, ?, ?, 1, ?, ?)`,
			row.ref, row.provider, row.cli, nowMS, nowMS); err != nil {
			t.Fatalf("insert v5 account error = %v", err)
		}
		if _, err := v5.ExecContext(ctx, `INSERT INTO account_profiles (account_ref, display_name, email, subscription_kind, subscription_raw, format_version, profile_json, updated_at_ms) VALUES (?, '', '', 'unknown', '', 1, ?, ?)`,
			row.ref, row.profileJSON, nowMS); err != nil {
			t.Fatalf("insert v5 profile error = %v", err)
		}
	}
	if err := v5.Close(); err != nil {
		t.Fatalf("close v5 database error = %v", err)
	}

	store, err := Open(ctx, OpenOptions{AIHomeDir: aiHomeDir, Catalog: newTestCatalog(t)})
	if err != nil {
		t.Fatalf("Open(v5) error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	want := map[string]string{
		"acct_aaaaaaaaaaaaaaaaaaaa": "ws-team",
		"acct_bbbbbbbbbbbbbbbbbbbb": "personal",
		"acct_cccccccccccccccccccc": "",
	}
	for ref, expected := range want {
		var got string
		if err := store.db.QueryRowContext(ctx, `SELECT workspace_id FROM account_profiles WHERE account_ref = ?`, ref).Scan(&got); err != nil {
			t.Fatalf("read workspace_id(%s) error = %v", ref, err)
		}
		if got != expected {
			t.Fatalf("workspace_id(%s) = %q, want %q", ref, got, expected)
		}
	}
	var version int
	if err := store.db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&version); err != nil || version != 6 {
		t.Fatalf("user_version = %d (%v), want 6", version, err)
	}
}
