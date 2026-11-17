//go:build windows

package dbunify

import (
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
)

// Windows rejects directory FlushFileBuffers. Backup files are individually
// Sync'd above; publish each one through a write-through MoveFileEx so parent
// metadata durability is not replaced with silently ignored EPERM.
func syncDirectory(path string) error {
	entries, err := os.ReadDir(path)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		source := filepath.Join(path, entry.Name())
		info, err := os.Lstat(source)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			continue
		}
		file, err := os.OpenFile(source, os.O_RDWR, 0)
		if err != nil {
			return err
		}
		err = file.Sync()
		file.Close()
		if err != nil {
			return err
		}
		temporary, err := os.CreateTemp(path, ".sync-publish-*")
		if err != nil {
			return err
		}
		target := temporary.Name()
		temporary.Close()
		if err = os.Remove(target); err != nil {
			return err
		}
		move := func(a, b string) error {
			from, err := windows.UTF16PtrFromString(a)
			if err != nil {
				return err
			}
			to, err := windows.UTF16PtrFromString(b)
			if err != nil {
				return err
			}
			return windows.MoveFileEx(from, to, windows.MOVEFILE_WRITE_THROUGH)
		}
		if err = move(source, target); err != nil {
			return err
		}
		if err = move(target, source); err != nil {
			return err
		}
	}
	return nil
}
