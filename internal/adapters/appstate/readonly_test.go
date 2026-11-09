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
