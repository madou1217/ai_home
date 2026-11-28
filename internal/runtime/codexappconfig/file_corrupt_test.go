package codexappconfig

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestPrepareConfigFileQuarantinesZeroFilledConfig 守住 2026-11-27 的事故形态：
// 断电后 config.toml 只剩长度、内容全是 NUL。旧代码会把这段 NUL 当普通文本
// Patch 回去，客户端永远起不来；现在必须留档改名并重建。
func TestPrepareConfigFileQuarantinesZeroFilledConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	corrupt := strings.Repeat(string([]byte{0}), 7151)
	if err := os.WriteFile(path, []byte(corrupt), 0o600); err != nil {
		t.Fatal(err)
	}

	account := AccountOnlyConfig{PreferredAuthMethod: "apikey", ModelProvider: "aih_server"}
	merged, err := PrepareConfigFile(path, account, SyncOptions{HasIsAPIKeyMode: true, IsAPIKeyMode: true}, HealOptions{})
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if strings.ContainsRune(merged, 0) {
		t.Fatal("merged config still carries NUL bytes")
	}

	written, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	if strings.ContainsRune(string(written), 0) {
		t.Fatal("rewritten config still carries NUL bytes")
	}
	if !strings.Contains(string(written), "model_provider") || !strings.Contains(string(written), "aih_server") {
		t.Fatalf("managed provider missing after rebuild: %q", string(written))
	}

	backups, err := filepath.Glob(path + corruptConfigBackupSuffix + "*")
	if err != nil {
		t.Fatal(err)
	}
	if len(backups) != 1 {
		t.Fatalf("expected exactly one corrupt backup, got %v", backups)
	}
	kept, err := os.ReadFile(backups[0])
	if err != nil {
		t.Fatal(err)
	}
	if string(kept) != corrupt {
		t.Fatalf("corrupt backup was altered: len=%d", len(kept))
	}
}

// TestPrepareConfigFileKeepsValidConfig 守住反向边界：正常配置不隔离、可重复执行。
func TestPrepareConfigFileKeepsValidConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	original := strings.Join([]string{
		"model_provider = 'aih_server'",
		"",
		"[projects.'c:\\work']",
		"trust_level = 'trusted'",
		"",
	}, "\n")
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}

	account := AccountOnlyConfig{PreferredAuthMethod: "apikey", ModelProvider: "aih_server"}
	first, err := PrepareConfigFile(path, account, SyncOptions{HasIsAPIKeyMode: true, IsAPIKeyMode: true}, HealOptions{})
	if err != nil {
		t.Fatal(err)
	}
	second, err := PrepareConfigFile(path, account, SyncOptions{HasIsAPIKeyMode: true, IsAPIKeyMode: true}, HealOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatal("PrepareConfigFile is not idempotent for a valid config")
	}
	if backups, _ := filepath.Glob(path + corruptConfigBackupSuffix + "*"); len(backups) != 0 {
		t.Fatalf("valid config was quarantined: %v", backups)
	}
}

// TestHealConfigFileKeepsEmptyConfig 证明“空文件”不等于“损坏”，不会被隔离。
func TestHealConfigFileKeepsEmptyConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := HealConfigFile(path, HealOptions{}); err != nil {
		t.Fatal(err)
	}
	if backups, _ := filepath.Glob(path + corruptConfigBackupSuffix + "*"); len(backups) != 0 {
		t.Fatalf("empty config treated as corrupt: %v", backups)
	}
}
