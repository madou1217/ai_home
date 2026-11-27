// Package httpfixtures 提供 HTTP 测试共享的账号落库辅助。
//
// 只被 _test.go 引用，不会进入生产二进制；集中一处是为了让所有 HTTP fixture
// 跟随 sqliteaccount 的真实 schema，而不是各自手写列集合。
package httpfixtures

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	_ "modernc.org/sqlite"
)

// SeedGoAccount 用 sqliteaccount 的真实 schema 建 aih.db，再插入一行账号。
// cli_account_id 按 Provider 递增，满足 UNIQUE(provider_id, cli_account_id)。
func SeedGoAccount(t *testing.T, directory, accountRef, provider string) {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	store, err := sqliteaccount.Open(context.Background(), sqliteaccount.OpenOptions{
		AIHomeDir: directory,
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("open aih.db: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close aih.db: %v", err)
	}
	database, err := sql.Open("sqlite", filepath.Join(directory, "aih.db"))
	if err != nil {
		t.Fatalf("open aih.db: %v", err)
	}
	defer func() { _ = database.Close() }()
	if _, err := database.Exec(
		"INSERT INTO accounts (account_ref, provider_id, cli_account_id, enabled, created_at_ms, updated_at_ms) "+
			"VALUES (?, ?, (SELECT COALESCE(MAX(cli_account_id), 0) + 1 FROM accounts WHERE provider_id = ?), 1, 1, 1)",
		accountRef, provider, provider,
	); err != nil {
		t.Fatalf("insert accounts: %v", err)
	}
}
