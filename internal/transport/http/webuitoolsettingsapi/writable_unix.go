//go:build !windows

package webuitoolsettingsapi

import (
	"os"
	"path/filepath"
	"syscall"
)

// W_OK；syscall.Access 在非 Windows 平台都可用，且不会像 OpenFile 那样产生副作用。
const writeAccessMode = 0x2

// writableTarget 复刻 Node isWritableTarget：文件存在就测文件；不存在就沿父目录
// 找到第一个存在的目录测它——「能创建」与「能写」在界面上是同一个结论。
func writableTarget(targetPath string) bool {
	if _, err := os.Stat(targetPath); err == nil {
		return syscall.Access(targetPath, writeAccessMode) == nil
	}
	directory := filepath.Dir(targetPath)
	for {
		if _, err := os.Stat(directory); err == nil {
			return syscall.Access(directory, writeAccessMode) == nil
		}
		parent := filepath.Dir(directory)
		if parent == directory || parent == "" {
			return false
		}
		directory = parent
	}
}
