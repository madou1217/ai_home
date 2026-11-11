package appstate

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

const testRef = "acct_0123456789abcdef0123"

func seed(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	path := filepath.Join(directory, DatabaseFileName)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = db.Close() }()
	for _, statement := range []string{
		`CREATE TABLE account_refs (account_ref TEXT PRIMARY KEY, provider TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
		`CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("create: %v", err)
		}
	}
	if _, err := db.Exec(`INSERT INTO account_refs VALUES (?, 'claude', 1, 1)`, testRef); err != nil {
		t.Fatalf("insert account_refs: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO app_kv VALUES ('k1', 'v1', 1)`); err != nil {
		t.Fatalf("insert app_kv: %v", err)
	}
	return path
}

// TestReadKVAndLookup 锁住共享只读访问的基本语义：命中、缺失、账号归属。
func TestReadKVAndLookup(t *testing.T) {
	ctx := context.Background()
	path := seed(t)
	value, found, err := ReadKV(ctx, path, "k1")
	if err != nil || !found || value != "v1" {
		t.Fatalf("ReadKV() = %q, %v, %v", value, found, err)
	}
	if _, found, err := ReadKV(ctx, path, "missing"); err != nil || found {
		t.Fatalf("missing key found=%v err=%v", found, err)
	}
	provider, found, err := LookupAccountProvider(ctx, path, testRef)
	if err != nil || !found || provider != "claude" {
		t.Fatalf("LookupAccountProvider() = %q, %v, %v", provider, found, err)
	}
	if _, found, err := LookupAccountProvider(ctx, path, "acct_ffffffffffffffffffff"); err != nil || found {
		t.Fatalf("unknown account found=%v err=%v", found, err)
	}
}

// TestMissingDatabaseIsEmpty 验证全新数据根不会被当成错误。
func TestMissingDatabaseIsEmpty(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), DatabaseFileName)
	if _, found, err := ReadKV(ctx, path, "k1"); err != nil || found {
		t.Fatalf("ReadKV() found=%v err=%v", found, err)
	}
	if _, found, err := LookupAccountProvider(ctx, path, testRef); err != nil || found {
		t.Fatalf("LookupAccountProvider() found=%v err=%v", found, err)
	}
}

// TestLookupAccountProviderFallsBackToGoStore 锁住「Go 独有账号」的归属判定。
//
// 账号的真实写入方已经是 Go（浏览器登录 / 导入），account_refs 只覆盖 Node 建过的账号。
// 只看 account_refs 会让模型上下文、账号配置、额度、路由规则等入口对 Go 独有账号一律 404。
func TestLookupAccountProviderFallsBackToGoStore(t *testing.T) {
	ctx := context.Background()
	appStatePath := seed(t)

	goDatabase, err := sql.Open("sqlite", filepath.Join(filepath.Dir(appStatePath), goAccountDatabaseFileName))
	if err != nil {
		t.Fatalf("open go store: %v", err)
	}
	defer func() { _ = goDatabase.Close() }()
	if _, err := goDatabase.Exec(
		`CREATE TABLE accounts (account_ref TEXT PRIMARY KEY, provider_id TEXT NOT NULL)`,
	); err != nil {
		t.Fatalf("create accounts: %v", err)
	}
	const goOnlyRef = "acct_0ea957d4866d74953fcd"
	if _, err := goDatabase.Exec(`INSERT INTO accounts VALUES (?, 'agy')`, goOnlyRef); err != nil {
		t.Fatalf("insert accounts: %v", err)
	}

	provider, found, err := LookupAccountProvider(ctx, appStatePath, goOnlyRef)
	if err != nil || !found || provider != "agy" {
		t.Fatalf("LookupAccountProvider(go-only) = %q/%v/%v, want agy/true/nil", provider, found, err)
	}
	// Node 台账仍然优先：同一个 ref 两边都有时以 account_refs 为准。
	provider, found, err = LookupAccountProvider(ctx, appStatePath, testRef)
	if err != nil || !found || provider != "claude" {
		t.Fatalf("LookupAccountProvider(node) = %q/%v/%v, want claude/true/nil", provider, found, err)
	}
	// 两边都没有：仍然按「不存在」处理。
	if _, found, err = LookupAccountProvider(ctx, appStatePath, "acct_ffffffffffffffffffff"); err != nil || found {
		t.Fatalf("LookupAccountProvider(missing) = %v/%v, want false/nil", found, err)
	}
	// 刷新所有权判定只看 Node 台账：Go 独有账号不能被视为宿主拥有。
	if _, found, err = LookupNodeAccountProvider(ctx, appStatePath, goOnlyRef); err != nil || found {
		t.Fatalf("LookupNodeAccountProvider(go-only) = %v/%v, want false/nil", found, err)
	}
	provider, found, err = LookupNodeAccountProvider(ctx, appStatePath, testRef)
	if err != nil || !found || provider != "claude" {
		t.Fatalf("LookupNodeAccountProvider(node) = %q/%v/%v, want claude/true/nil", provider, found, err)
	}
}
