package accountprojection

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
)

// writeFileAtomic 在目标目录写临时文件、fsync、chmod，再原子 rename。
//
// 失败时只清理临时文件，不删除已有目标；Windows 的 rename-over-existing 失败时
// 才做一次“删旧目标再 rename”（临时文件已完整写入）。
func writeFileAtomic(path string, data []byte, mode fs.FileMode) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(directory, ".aih-auth-*.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	renamed := false
	defer func() {
		if !renamed {
			_ = os.Remove(tempPath)
		}
	}()
	if err := temp.Chmod(mode); err != nil {
		_ = temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempPath, path); err != nil {
		if runtime.GOOS != "windows" {
			return err
		}
		if removeErr := os.Remove(path); removeErr != nil && !errors.Is(removeErr, fs.ErrNotExist) {
			return err
		}
		if retryErr := os.Rename(tempPath, path); retryErr != nil {
			return retryErr
		}
	}
	renamed = true
	return os.Chmod(path, mode)
}
