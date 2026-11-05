package sqliteaccount

import (
	"context"
	"os"
	"testing"

	"github.com/madou1217/ai_home/core/providers"
)

// 用真实 aih.db 的副本验证 v21 → v22 升级（生产库在服务运行时不能直接开）。
func TestUpgradeRealDatabaseCopy(t *testing.T) {
	source := os.Getenv("AIH_REAL_DB")
	if source == "" {
		t.Skip("未设置 AIH_REAL_DB")
	}
	payload, err := os.ReadFile(source)
	if err != nil {
		t.Fatalf("读取真实库失败: %v", err)
	}
	dir := t.TempDir()
	if err := os.WriteFile(dir+"/aih.db", payload, 0o644); err != nil {
		t.Fatalf("写入副本失败: %v", err)
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	store, err := Open(context.Background(), OpenOptions{AIHomeDir: dir, Catalog: catalog})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer func() { _ = store.Close() }()
	var version int
	if err := store.db.QueryRowContext(context.Background(), "PRAGMA user_version").Scan(&version); err != nil {
		t.Fatalf("读取版本失败: %v", err)
	}
	if version != SchemaVersion {
		t.Fatalf("user_version = %d, want %d", version, SchemaVersion)
	}
	var accounts int
	if err := store.db.QueryRowContext(context.Background(), "SELECT COUNT(*) FROM accounts").Scan(&accounts); err != nil {
		t.Fatalf("统计账号失败: %v", err)
	}
	t.Logf("升级后 accounts=%d", accounts)
	records, generation, err := store.ListModelAliases(context.Background())
	if err != nil {
		t.Fatalf("ListModelAliases() error = %v", err)
	}
	if len(records) != 0 || generation != 0 {
		t.Fatalf("新表应为空: %d 条 / %d", len(records), generation)
	}
}
