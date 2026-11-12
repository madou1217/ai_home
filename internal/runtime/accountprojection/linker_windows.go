//go:build windows

package accountprojection

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	appprojection "github.com/madou1217/ai_home/application/accountprojection"
)

type windowsLinker struct{}

// NewLinker 返回 Windows 链接实现：优先 symlink，文件退化为 hardlink；
// 目录在无 symlink 权限时失败关闭（不做危险的递归复制）。
func NewLinker() appprojection.Linker { return windowsLinker{} }

func (windowsLinker) Link(linkPath string, targetPath string, directory bool) error {
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
	if err := os.Symlink(targetPath, linkPath); err == nil {
		return nil
	} else if directory {
		return fmt.Errorf("directory link requires symlink privilege: %w", err)
	}
	return os.Link(targetPath, linkPath)
}

func (windowsLinker) IsManaged(linkPath string, targetPath string) bool {
	linkInfo, err := os.Lstat(linkPath)
	if err != nil {
		return false
	}
	if linkInfo.Mode()&os.ModeSymlink != 0 {
		destination, readErr := os.Readlink(linkPath)
		if readErr != nil {
			return false
		}
		if !filepath.IsAbs(destination) {
			destination = filepath.Join(filepath.Dir(linkPath), destination)
		}
		destination, _ = filepath.Abs(destination)
		target, _ := filepath.Abs(targetPath)
		return filepath.Clean(destination) == filepath.Clean(target)
	}
	targetInfo, statErr := os.Stat(targetPath)
	return statErr == nil && os.SameFile(linkInfo, targetInfo)
}

func (linker windowsLinker) RemoveManaged(linkPath string, targetPath string) error {
	if !linker.IsManaged(linkPath, targetPath) {
		return appprojection.ErrProjectionConflict
	}
	return os.Remove(linkPath)
}
