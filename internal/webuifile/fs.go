package webuifile

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/storagepolicy"
)

// FS 是 Node 侧 deps.fs 的最小投影：文件访问策略只依赖 stat/readdir/readfile/realpath。
// 注入接口而不是直接调 os，是为了让符号链接越界、凭证文件拒绝这类判定能被确定性测试覆盖。
type FS interface {
	Stat(name string) (os.FileInfo, error)
	ReadDir(name string) ([]os.DirEntry, error)
	EvalSymlinks(name string) (string, error)
}

// OSFS 是 FS 的本地文件系统实现。
type OSFS struct{}

func (OSFS) Stat(name string) (os.FileInfo, error)      { return os.Stat(name) }
func (OSFS) ReadDir(name string) ([]os.DirEntry, error) { return os.ReadDir(name) }
func (OSFS) EvalSymlinks(name string) (string, error)   { return filepath.EvalSymlinks(name) }

// WithinRoot 对应 isPathWithinRoot：target 等于 root 或位于其子目录时为 true。
// 实现复用 storagepolicy.PathWithinRoot，避免两套包含判定漂移。
func WithinRoot(root, target string) bool {
	if root == "" || target == "" {
		return false
	}
	return storagepolicy.PathWithinRoot(root, target)
}

// absPath 对应 path.resolve：转绝对路径并清理。
func absPath(value string) (string, error) {
	if filepath.IsAbs(value) {
		return filepath.Clean(value), nil
	}
	return filepath.Abs(value)
}

// resolveRealPathOrSelf 对应 resolveRealPathOrSelf：realpath 失败时退回自身绝对路径。
func resolveRealPathOrSelf(fs FS, target string) string {
	if real, err := fs.EvalSymlinks(target); err == nil {
		if abs, absErr := absPath(real); absErr == nil {
			return abs
		}
	}
	abs, err := absPath(target)
	if err != nil {
		return filepath.Clean(target)
	}
	return abs
}

// realPathStrict 对应 Node 里带 try/catch 的 realpathSync：失败即判定失败。
func realPathStrict(fs FS, target string) (string, error) {
	real, err := fs.EvalSymlinks(target)
	if err != nil {
		return "", err
	}
	return absPath(real)
}

// normalizeSlashPath 对应 normalizeSlashPath：统一分隔符并去掉前导 "./"。
func normalizeSlashPath(value string) string {
	normalized := strings.ReplaceAll(strings.TrimSpace(value), "\\", "/")
	for strings.HasPrefix(normalized, "./") {
		normalized = strings.TrimPrefix(normalized, "./")
	}
	return normalized
}

// dedupe 保持首次出现顺序地去掉空串与重复项。
func dedupe(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}
