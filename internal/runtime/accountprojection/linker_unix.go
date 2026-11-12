//go:build !windows

package accountprojection

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	appprojection "github.com/madou1217/ai_home/application/accountprojection"
)

type symlinkLinker struct{}

// NewLinker 返回 POSIX 符号链接实现。
func NewLinker() appprojection.Linker { return symlinkLinker{} }

func (symlinkLinker) Link(linkPath string, targetPath string, _ bool) error {
	if linkPath == "" || targetPath == "" {
		return appprojection.ErrInvalidProjectionRoot
	}
	if err := os.MkdirAll(filepath.Dir(linkPath), 0o700); err != nil {
		return err
	}
	if _, err := os.Lstat(linkPath); err == nil {
		return fs.ErrExist
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return os.Symlink(targetPath, linkPath)
}

func (symlinkLinker) IsManaged(linkPath string, targetPath string) bool {
	info, err := os.Lstat(linkPath)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		return false
	}
	destination, err := os.Readlink(linkPath)
	if err != nil {
		return false
	}
	if !filepath.IsAbs(destination) {
		destination = filepath.Join(filepath.Dir(linkPath), destination)
	}
	destination, err = filepath.Abs(destination)
	if err != nil {
		return false
	}
	target, err := filepath.Abs(targetPath)
	if err != nil {
		return false
	}
	return filepath.Clean(destination) == filepath.Clean(target)
}

func (linker symlinkLinker) RemoveManaged(linkPath string, targetPath string) error {
	if !linker.IsManaged(linkPath, targetPath) {
		return appprojection.ErrProjectionConflict
	}
	return os.Remove(linkPath)
}
