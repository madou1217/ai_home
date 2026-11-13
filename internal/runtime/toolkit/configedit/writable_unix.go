//go:build !windows

package configedit

import (
	"os"
	"path/filepath"
	"syscall"
)

func isWritableTarget(targetPath string) bool {
	if targetPath == "" {
		return false
	}
	cur := targetPath
	for cur != "" {
		if _, err := os.Stat(cur); err == nil {
			return syscall.Access(cur, 2 /* W_OK */) == nil
		}
		parent := filepath.Dir(cur)
		if parent == "" || parent == cur {
			return false
		}
		cur = parent
	}
	return false
}
