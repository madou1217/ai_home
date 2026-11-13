//go:build windows

package accountprojection

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	appprojection "github.com/madou1217/ai_home/application/accountprojection"
)

type windowsLinker struct{}

// NewLinker 返回 Windows 链接实现：优先 symlink；目录退化为 junction（不需要
// SeCreateSymbolicLinkPrivilege），文件退化为 hardlink。绝不递归复制。
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
		// 普通用户没有 symlink 权限；junction 是目录的等价重解析点，权限要求更低。
		return createJunction(linkPath, targetPath, err)
	}
	return os.Link(targetPath, linkPath)
}

// createJunction 用系统自带 mklink /J 创建目录 junction；失败时把两条错误一起
// 返回，便于区分「没有权限」和「目标不存在」。
func createJunction(linkPath string, targetPath string, symlinkErr error) error {
	shell := strings.TrimSpace(os.Getenv("COMSPEC"))
	if shell == "" {
		shell = "cmd.exe"
	}
	output, err := exec.Command(
		shell, "/d", "/c", "mklink", "/J", linkPath, targetPath,
	).CombinedOutput()
	if err != nil {
		return fmt.Errorf(
			"create junction %s -> %s: %w (symlink: %v, mklink: %s)",
			linkPath,
			targetPath,
			err,
			symlinkErr,
			strings.TrimSpace(string(output)),
		)
	}
	return nil
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
