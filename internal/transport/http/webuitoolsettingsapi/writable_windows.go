//go:build windows

package webuitoolsettingsapi

import (
	"os"
	"path/filepath"
)

// writableTarget 在 Windows 上没有等价的 access(2)：用「打开不截断」与
// 「在目标目录建临时文件」探测，结论与 Node 的 fs.accessSync(W_OK) 对齐。
func writableTarget(targetPath string) bool {
	if info, err := os.Stat(targetPath); err == nil && !info.IsDir() {
		file, openErr := os.OpenFile(targetPath, os.O_WRONLY, 0)
		if openErr != nil {
			return false
		}
		_ = file.Close()
		return true
	}
	directory := filepath.Dir(targetPath)
	for {
		if info, err := os.Stat(directory); err == nil && info.IsDir() {
			probe, createErr := os.CreateTemp(directory, ".aih-write-probe-*")
			if createErr != nil {
				return false
			}
			name := probe.Name()
			_ = probe.Close()
			_ = os.Remove(name)
			return true
		}
		parent := filepath.Dir(directory)
		if parent == directory || parent == "" {
			return false
		}
		directory = parent
	}
}
