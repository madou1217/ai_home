package deletionprojection

import (
	"os"
	"path/filepath"
	"testing"
)

// TestEnsureSafeAbsoluteDirectoryRejectsSymlinkRoot 验证目标恰好等于 root 时
// 也必须重新 lstat，不能因为 relative="." 跳过 symlink 检查。
func TestEnsureSafeAbsoluteDirectoryRejectsSymlinkRoot(t *testing.T) {
	t.Parallel()

	parent := t.TempDir()
	outside := t.TempDir()
	root := filepath.Join(parent, ".codex")
	if err := os.Symlink(outside, root); err != nil {
		t.Fatalf("Symlink(root) error = %v", err)
	}
	if err := ensureSafeAbsoluteDirectory(root, root); err == nil {
		t.Fatal("symlink root 应失败关闭")
	}
}

// TestReadBoundedRegularFileRejectsSymlinkRoot 验证 credential 读取不会在
// 初次枚举后跟随被替换的 projection root。
func TestReadBoundedRegularFileRejectsSymlinkRoot(t *testing.T) {
	t.Parallel()

	parent := t.TempDir()
	outside := t.TempDir()
	writePath := filepath.Join(outside, ".codex", "auth.json")
	if err := os.MkdirAll(filepath.Dir(writePath), 0o700); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(writePath, []byte(`{"secret":"outside"}`), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	root := filepath.Join(parent, "projection")
	if err := os.Symlink(outside, root); err != nil {
		t.Fatalf("Symlink(projection) error = %v", err)
	}
	if _, _, err := readBoundedRegularFile(root, []string{".codex", "auth.json"}); err == nil {
		t.Fatal("symlink projection root 应失败关闭")
	}
}
