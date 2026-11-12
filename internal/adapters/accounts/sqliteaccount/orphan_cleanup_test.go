package sqliteaccount

import (
	"context"
	"database/sql"
	"testing"

	"github.com/madou1217/ai_home/core/providers"
)

// 外键只在 foreign_keys=ON 的连接上生效；历史库/外部写入可能留下孤儿凭据。
// Open 必须自愈，不能把敏感凭据留在没有账号行的表里。
func TestOpenDeletesOrphanCredentials(t *testing.T) {
	ctx := context.Background()
	aiHomeDir := t.TempDir()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	store, err := Open(ctx, OpenOptions{AIHomeDir: aiHomeDir, Catalog: catalog})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	databasePath, err := DatabasePath(aiHomeDir)
	if err != nil {
		t.Fatalf("DatabasePath() error = %v", err)
	}
	raw, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	if _, err := raw.ExecContext(ctx, "PRAGMA foreign_keys=OFF"); err != nil {
		_ = raw.Close()
		t.Fatalf("disable foreign keys error = %v", err)
	}
	if _, err := raw.ExecContext(ctx, `INSERT INTO account_credentials (
			account_ref, credential_ref, auth_kind, auth_mode, format_version,
			credential_json, updated_at_ms
		) VALUES ('acct_0123456789abcdef9999', 'cred_0123456789abcdef9999',
			'oauth', 'consumer', 1, '{"email":"orphan@example.test"}', 100000)`); err != nil {
		_ = raw.Close()
		t.Fatalf("insert orphan credential error = %v", err)
	}
	_ = raw.Close()

	reopened, err := Open(ctx, OpenOptions{AIHomeDir: aiHomeDir, Catalog: catalog})
	if err != nil {
		t.Fatalf("reopen error = %v", err)
	}
	defer func() { _ = reopened.Close() }()
	var count int
	if err := reopened.db.QueryRowContext(
		ctx,
		"SELECT COUNT(*) FROM account_credentials WHERE account_ref NOT IN (SELECT account_ref FROM accounts)",
	).Scan(&count); err != nil {
		t.Fatalf("count orphan credentials error = %v", err)
	}
	if count != 0 {
		t.Fatalf("orphan credentials = %d, want 0", count)
	}
}
