package configsnapshot

import (
	"errors"
	"os"
	"path/filepath"
)

// Acquire owns the same canonical lock as Update, for a focused multi-file
// coordinator's journal. The target itself is not created or modified.
func Acquire(requested string) (target string, release func(), err error) {
	target, err = targetPath(requested)
	if err != nil {
		return "", nil, err
	}
	if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		return "", nil, err
	}
	lockPath := target + ".aih-config.lock"
	if info, e := os.Lstat(lockPath); e == nil && !info.Mode().IsRegular() {
		return "", nil, errors.New("native_config_lock_invalid")
	} else if e != nil && !errors.Is(e, os.ErrNotExist) {
		return "", nil, e
	}
	file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return "", nil, err
	}
	opened, err := file.Stat()
	if err != nil {
		file.Close()
		return "", nil, err
	}
	observed, err := os.Lstat(lockPath)
	if err != nil || !observed.Mode().IsRegular() || !os.SameFile(opened, observed) {
		file.Close()
		return "", nil, ErrChanged
	}
	if err = lockExclusive(file); err != nil {
		file.Close()
		return "", nil, errors.New("native_config_busy")
	}
	return target, func() { unlockExclusive(file); _ = file.Close() }, nil
}

// Resolve exposes the same observed-path binding used by Read/Update. It does
// not create files and does not bypass recovery markers.
func Resolve(requested string) (string, error) { return targetPath(requested) }
