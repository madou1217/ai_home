package accountbrowserhost

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

func openValidatedSessionRoot(dir string) (*os.Root, fs.FileInfo, error) {
	if dir == "" || strings.TrimSpace(dir) != dir || strings.ContainsRune(dir, 0) ||
		!filepath.IsAbs(dir) || filepath.Clean(dir) != dir || dir == filepath.Dir(dir) {
		return nil, nil, fmt.Errorf("session directory path invalid: %w", ErrUnsafePath)
	}
	for _, seg := range strings.FieldsFunc(dir, func(r rune) bool { return r == '/' || r == '\\' }) {
		if seg == ".." {
			return nil, nil, fmt.Errorf("session directory traversal rejected: %w", ErrUnsafePath)
		}
	}
	lstatInfo, err := os.Lstat(dir)
	if err != nil || !isSafePrivateDir(lstatInfo) {
		return nil, nil, fmt.Errorf("session directory must exist as private real directory: %w", ErrUnsafePath)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, nil, fmt.Errorf("open session root: %w", ErrUnsafePath)
	}
	openedInfo, err := root.Stat(".")
	if err != nil || !isSafePrivateDir(openedInfo) || !os.SameFile(lstatInfo, openedInfo) {
		_ = root.Close()
		return nil, nil, fmt.Errorf("session root identity mismatch: %w", ErrUnsafePath)
	}
	canon, err := filepath.EvalSymlinks(dir)
	if err != nil {
		_ = root.Close()
		return nil, nil, fmt.Errorf("resolve canonical session directory: %w", ErrUnsafePath)
	}
	if canonInfo, err := os.Lstat(canon); err != nil || !isSafePrivateDir(canonInfo) || !os.SameFile(openedInfo, canonInfo) {
		_ = root.Close()
		return nil, nil, fmt.Errorf("canonical session directory escaped root: %w", ErrUnsafePath)
	}
	return root, openedInfo, nil
}

func openLockFile(root *os.Root) (*os.File, fs.FileInfo, error) {
	preInfo, err := root.Lstat(lockFileName)
	if err == nil && !isSafePrivateRegular(preInfo) {
		return nil, nil, fmt.Errorf("host lock file unsafe: %w", ErrUnsafePath)
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, nil, stripPathErr("stat host lock", err)
	}
	f, err := root.OpenFile(lockFileName, os.O_RDWR|os.O_CREATE|os.O_EXCL, privateFilePerm)
	if err != nil {
		if !errors.Is(err, os.ErrExist) {
			return nil, nil, stripPathErr("create host lock", err)
		}
		if preInfo, err = root.Lstat(lockFileName); err != nil {
			return nil, nil, stripPathErr("re-stat host lock", err)
		}
		if !isSafePrivateRegular(preInfo) {
			return nil, nil, fmt.Errorf("host lock file unsafe: %w", ErrUnsafePath)
		}
		if f, err = root.OpenFile(lockFileName, os.O_RDWR, 0); err != nil {
			return nil, nil, stripPathErr("open host lock", err)
		}
	}
	fstat, err := verifyRegularFD(root, lockFileName, f, preInfo)
	if err != nil {
		_ = f.Close()
		return nil, nil, err
	}
	return f, fstat, nil
}

func verifyRegularFD(root *os.Root, name string, f *os.File, expected fs.FileInfo) (fs.FileInfo, error) {
	lstatInfo, lErr := root.Lstat(name)
	fstatInfo, fErr := f.Stat()
	if lErr != nil || fErr != nil || !isSafePrivateRegular(lstatInfo) || !isSafePrivateRegular(fstatInfo) ||
		!os.SameFile(lstatInfo, fstatInfo) || (expected != nil && !os.SameFile(expected, fstatInfo)) {
		return nil, fmt.Errorf("file identity mismatch: %w", ErrUnsafePath)
	}
	return fstatInfo, nil
}

func checkNoActiveMarker(root *os.Root) error {
	info, err := root.Lstat(activeMarkerFileName)
	if err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("active marker is symlink: %w", ErrUnsafePath)
		}
		return fmt.Errorf("unclean host active marker present: %w", ErrRecoveryRequired)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return stripPathErr("stat active marker", err)
	}
	return nil
}

func syncRoot(root *os.Root) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	d, err := root.Open(".")
	if err != nil {
		return stripPathErr("open session root for sync", err)
	}
	syncErr, closeErr := d.Sync(), d.Close()
	if syncErr != nil {
		return stripPathErr("sync session root", syncErr)
	}
	if closeErr != nil {
		return stripPathErr("close session root after sync", closeErr)
	}
	return nil
}

func isSafePrivateDir(info fs.FileInfo) bool {
	return info.Mode()&os.ModeSymlink == 0 && info.IsDir() && (runtime.GOOS == "windows" || info.Mode().Perm()&0o077 == 0)
}

func isSafePrivateRegular(info fs.FileInfo) bool {
	return info.Mode()&os.ModeSymlink == 0 && info.Mode().IsRegular() && (runtime.GOOS == "windows" || info.Mode().Perm()&0o177 == 0)
}

func stripPathErr(stage string, err error) error {
	var pathErr *fs.PathError
	if errors.As(err, &pathErr) && pathErr.Err != nil {
		return fmt.Errorf("%s: %w", stage, pathErr.Err)
	}
	var linkErr *os.LinkError
	if errors.As(err, &linkErr) && linkErr.Err != nil {
		return fmt.Errorf("%s: %w", stage, linkErr.Err)
	}
	return fmt.Errorf("%s: %w", stage, err)
}
