package nativeresources

import (
	"os"
	"path/filepath"
	"testing"
)

// 各 AI 指令文件统一到 AGENTS.md 后，目标就是软链；原子写入必须穿透软链改
// 真源，不能把链接替换成普通文件，否则统一布局会在一次 skill 安装后失效。
func TestAtomicWriteFileFollowsSymlink(t *testing.T) {
	dir := t.TempDir()
	canonical := filepath.Join(dir, "AGENTS.md")
	link := filepath.Join(dir, "GEMINI.md")
	if err := os.WriteFile(canonical, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(canonical, link); err != nil {
		t.Fatal(err)
	}
	if err := atomicWriteFile(link, []byte("new"), 0o600); err != nil {
		t.Fatalf("atomicWriteFile: %v", err)
	}
	info, err := os.Lstat(link)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("软链被替换成了普通文件")
	}
	got, err := os.ReadFile(canonical)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new" {
		t.Fatalf("真源应被更新，实际 %q", string(got))
	}
}
