package agentinstructions

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func setupHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	for _, dir := range []string{".codebuddy", ".codebuddy-cn", ".claude", ".codex"} {
		if err := os.MkdirAll(filepath.Join(home, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return home
}

func TestEnsureCreatesCanonicalAndOnlyLinksInstalledProviders(t *testing.T) {
	home := setupHome(t)
	result, err := Ensure(context.Background(), Options{HostHome: home})
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if !result.CreatedCanonical {
		t.Fatal("首次运行应创建 AGENTS.md")
	}
	if got := len(result.Linked); got != 4 {
		t.Fatalf("已存在 4 个 CLI 目录，应链接 4 个，实际 %d (%v)", got, result.Linked)
	}
	// 没装 Gemini：不应创建 ~/.gemini
	if _, err := os.Stat(filepath.Join(home, ".gemini")); !os.IsNotExist(err) {
		t.Fatal("不应给未安装的 CLI 造目录")
	}
	content, err := os.ReadFile(filepath.Join(home, "AGENTS.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), "唯一真源") {
		t.Fatalf("真源应带说明，实际: %q", string(content))
	}
}

func TestEnsureMigratesExistingRulesWithoutLosingContent(t *testing.T) {
	home := setupHome(t)
	claude := filepath.Join(home, ".claude/CLAUDE.md")
	original := "# 用户规则\n\n- 回答用中文\n"
	if err := os.WriteFile(claude, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}

	result, err := Ensure(context.Background(), Options{HostHome: home})
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if len(result.Migrated) != 1 {
		t.Fatalf("应迁移 1 个文件，实际 %v", result.Migrated)
	}
	canonical, err := os.ReadFile(filepath.Join(home, "AGENTS.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(canonical), "回答用中文") {
		t.Fatalf("真源应包含原规则，实际: %q", string(canonical))
	}
	info, err := os.Lstat(claude)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("迁移后应替换为软链")
	}
	matches, _ := filepath.Glob(claude + ".aih-backup-*")
	if len(matches) != 1 {
		t.Fatalf("应保留一份备份，实际 %v", matches)
	}
	backup, _ := os.ReadFile(matches[0])
	if string(backup) != original {
		t.Fatalf("备份内容应与原文一致，实际: %q", string(backup))
	}
}

func TestEnsureIsIdempotent(t *testing.T) {
	home := setupHome(t)
	if _, err := Ensure(context.Background(), Options{HostHome: home}); err != nil {
		t.Fatal(err)
	}
	second, err := Ensure(context.Background(), Options{HostHome: home})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Linked) != 0 || len(second.Migrated) != 0 {
		t.Fatalf("第二次不应再有动作: linked=%v migrated=%v", second.Linked, second.Migrated)
	}
	if len(second.AlreadyLinked) != 4 {
		t.Fatalf("四个目标应已链接，实际 %v", second.AlreadyLinked)
	}
}

func TestEnsureLeavesForeignSymlinkAlone(t *testing.T) {
	home := setupHome(t)
	other := filepath.Join(home, "other-rules.md")
	if err := os.WriteFile(other, []byte("# other\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	codex := filepath.Join(home, ".codex/AGENTS.md")
	if err := os.Symlink(other, codex); err != nil {
		t.Fatal(err)
	}
	result, err := Ensure(context.Background(), Options{HostHome: home})
	if err != nil {
		t.Fatal(err)
	}
	target, err := os.Readlink(codex)
	if err != nil {
		t.Fatal(err)
	}
	if target != other {
		t.Fatalf("不应改写指向别处的软链，实际指向 %s", target)
	}
	if len(result.Skipped) != 1 {
		t.Fatalf("应记一次跳过，实际 %v", result.Skipped)
	}
}
