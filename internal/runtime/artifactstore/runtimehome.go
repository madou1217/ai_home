package artifactstore

import (
	"os"
	"path/filepath"
	"strings"
)

// RuntimeHomeEntry 是"某个 CLI 的私有 runtime 目录"声明：目录必须真实（不能是链接）、
// 权限 0700，且里面的原生数据库文件用**相对**文件链接指回账号私有那份。
type RuntimeHomeEntry struct {
	Root        string         `json:"root"`
	HostHomeDir string         `json:"hostHomeDir,omitempty"`
	PrivateDirs [][]string     `json:"privateDirs,omitempty"`
	FileLink    *FileLinkEntry `json:"fileLink,omitempty"`
}

type FileLinkEntry struct {
	Path   []string `json:"path"`
	Target string   `json:"target"`
}

type RuntimeHomeResult struct {
	Migrated int    `json:"migrated,omitempty"`
	Linked   int    `json:"linked,omitempty"`
	Error    string `json:"error,omitempty"`
}

func applyRuntimeHomes(request Request) []RuntimeHomeResult {
	results := make([]RuntimeHomeResult, 0, len(request.RuntimeHomes))
	for _, entry := range request.RuntimeHomes {
		results = append(results, applyRuntimeHome(entry))
	}
	return results
}

func applyRuntimeHome(entry RuntimeHomeEntry) RuntimeHomeResult {
	result := RuntimeHomeResult{}
	root := strings.TrimSpace(entry.Root)
	if root == "" {
		return result
	}
	hostHome := strings.TrimSpace(entry.HostHomeDir)
	if hostHome != "" && filepath.Clean(root) == filepath.Clean(hostHome) {
		result.Error = "kiro_runtime_home_not_isolated"
		return result
	}
	if err := ensurePrivateDirectory(root); err != nil {
		result.Error = "kiro_runtime_directory_not_private"
		return result
	}
	for _, segments := range entry.PrivateDirs {
		directory := filepath.Join(root, filepath.Join(segments...))
		// 旧版通用对账曾把宿主 HOME 链进账号：只摘掉"恰好指向宿主同名目录"的那条链接，
		// 绝不读写它的目标。
		if info, err := os.Lstat(directory); err == nil && isLinkEntry(info, directory) && hostHome != "" {
			if link, readErr := os.Readlink(directory); readErr == nil {
				if !filepath.IsAbs(link) {
					link = filepath.Join(filepath.Dir(directory), link)
				}
				if normalizeCompare(link) == normalizeCompare(filepath.Join(hostHome, filepath.Join(segments...))) {
					if removeErr := os.Remove(directory); removeErr == nil {
						result.Migrated++
					}
				}
			}
		}
		if err := ensurePrivateDirectory(directory); err != nil {
			result.Error = "kiro_runtime_directory_not_private"
			return result
		}
	}
	if entry.FileLink == nil || len(entry.FileLink.Path) == 0 {
		return result
	}
	target := strings.TrimSpace(entry.FileLink.Target)
	if target == "" {
		return result
	}
	nativePath := filepath.Join(root, filepath.Join(entry.FileLink.Path...))
	if info, err := os.Lstat(nativePath); err == nil {
		if isLinkEntry(info, nativePath) && linkPointsTo(nativePath, target) {
			return result
		}
		result.Error = "kiro_native_database_path_conflict"
		return result
	}
	if err := os.MkdirAll(filepath.Dir(nativePath), 0o700); err != nil {
		result.Error = "kiro_native_database_path_conflict"
		return result
	}
	relative, err := filepath.Rel(filepath.Dir(nativePath), target)
	if err != nil {
		result.Error = "kiro_native_database_path_conflict"
		return result
	}
	if err := os.Symlink(relative, nativePath); err != nil {
		result.Error = "kiro_native_database_path_conflict"
		return result
	}
	result.Linked++
	return result
}

// ensurePrivateDirectory 只接受"真实目录"：链接（含 junction）与文件都算私有性被破坏。
func ensurePrivateDirectory(directory string) error {
	info, err := os.Lstat(directory)
	if err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return os.ErrInvalid
		}
		return nil
	}
	if !os.IsNotExist(err) {
		return err
	}
	return os.MkdirAll(directory, 0o700)
}
