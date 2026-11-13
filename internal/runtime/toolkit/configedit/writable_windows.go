//go:build windows

package configedit

import (
	"os"
	"path/filepath"
)

func isWritableTarget(targetPath string) bool {
	if targetPath == "" {
		return false
	}
	cur := targetPath
	for cur != "" {
		info, err := os.Stat(cur)
		if err == nil {
			return info.Mode().Perm()&0o200 != 0
		}
		parent := filepath.Dir(cur)
		if parent == "" || parent == cur {
			return false
		}
		cur = parent
	}
	return false
}
