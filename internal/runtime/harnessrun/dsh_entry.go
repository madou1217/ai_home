package harnessrun

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	dshEntryModuleExt = regexp.MustCompile(`(?i)\.(js|mjs|cjs)$`)
	dshShimPosix      = regexp.MustCompile(`(?m)cmd-shim-target=(.+)\s*$`)
	dshShimWindows    = regexp.MustCompile(`(?i)[A-Za-z]:\\[^"\r\n]*?node_modules\\@deepseek-ai\\dsh\\lib\\bin\.js`)
	dshShimRelative   = regexp.MustCompile(`(?i)(%~dp0[\\/])?([^\s"']*node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js)`)
)

// resolveDshEntry 复刻 Node resolveDshEntry：
//   - 候选路径本身是 JS 入口（含软链接解析后）时直接用；
//   - 否则把 npm / pnpm 生成的 shim 文本解析成真实 bin.js；
//   - 一律按真实路径返回，pnpm store 的兄弟依赖才找得到。
func resolveDshEntry(candidate string) string {
	candidate = strings.TrimSpace(candidate)
	if candidate == "" {
		return ""
	}
	if real, err := filepath.EvalSymlinks(candidate); err == nil && dshEntryModuleExt.MatchString(real) {
		return real
	}
	content, err := os.ReadFile(candidate)
	if err != nil {
		return ""
	}
	text := string(content)
	target := extractShimTarget(text)
	if target == "" {
		return ""
	}
	resolved := target
	if !filepath.IsAbs(target) {
		resolved = filepath.Join(filepath.Dir(candidate), target)
	}
	if real, err := filepath.EvalSymlinks(resolved); err == nil {
		if _, statErr := os.Stat(real); statErr == nil {
			return real
		}
	}
	if _, err := os.Stat(resolved); err == nil {
		return resolved
	}
	return ""
}

func extractShimTarget(text string) string {
	if match := dshShimPosix.FindStringSubmatch(text); len(match) > 1 {
		if target := strings.TrimSpace(match[1]); target != "" {
			return target
		}
	}
	if match := dshShimWindows.FindString(text); match != "" {
		return match
	}
	if match := dshShimRelative.FindStringSubmatch(text); len(match) > 2 {
		return strings.TrimSpace(match[2])
	}
	return ""
}

// resolveDshNodePath 复刻 resolveDshNodePath：从 DSH 入口解析
// node-addon-require-builtin 的包入口，再取三层 dirname 得到需要放进
// NODE_PATH 的 node_modules（pnpm 全局安装的平台包只在它下面）。
func resolveDshNodePath(entryPath string) string {
	entry := strings.TrimSpace(entryPath)
	if entry == "" {
		return ""
	}
	directory := filepath.Dir(entry)
	for {
		packageDir := filepath.Join(directory, "node_modules", "node-addon-require-builtin")
		if info, err := os.Stat(packageDir); err == nil && info.IsDir() {
			entryFile := resolvePackageEntry(packageDir)
			if entryFile == "" {
				return ""
			}
			return filepath.Dir(filepath.Dir(filepath.Dir(entryFile)))
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			return ""
		}
		directory = parent
	}
}

func resolvePackageEntry(packageDir string) string {
	manifestPath := filepath.Join(packageDir, "package.json")
	content, err := os.ReadFile(manifestPath)
	if err != nil {
		return ""
	}
	var manifest struct {
		Main    string `json:"main"`
		Exports any    `json:"exports"`
	}
	if err := json.Unmarshal(content, &manifest); err != nil {
		return ""
	}
	candidate := packageExportEntry(manifest.Exports)
	if candidate == "" {
		candidate = strings.TrimSpace(manifest.Main)
	}
	if candidate == "" {
		candidate = "index.js"
	}
	candidate = strings.TrimPrefix(candidate, "./")
	entryFile := filepath.Join(packageDir, filepath.FromSlash(candidate))
	if info, err := os.Stat(entryFile); err == nil && !info.IsDir() {
		return entryFile
	}
	return ""
}

func packageExportEntry(exports any) string {
	root, ok := exports.(map[string]any)
	if !ok {
		return ""
	}
	dot, ok := root["."]
	if !ok {
		return ""
	}
	if value, ok := dot.(string); ok {
		return value
	}
	nested, ok := dot.(map[string]any)
	if !ok {
		return ""
	}
	for _, key := range []string{"require", "import", "default"} {
		if value, ok := nested[key].(string); ok && value != "" {
			return value
		}
	}
	return ""
}

// resolveNodeExecutable 返回用于执行 DSH JS 入口的 Node。
//
// Node 侧用 process.execPath；Go CLI 没有同一个“当前 Node”，因此按宿主注入的
// AIH_SERVER_NODE_EXEC 优先，其次 PATH 上的 node。仅用于真正运行 harness 入口。
func resolveNodeExecutable(lookupEnv func(string) (string, bool)) (string, error) {
	if value := firstEnvValue(lookupEnv, "AIH_SERVER_NODE_EXEC"); value != "" {
		return value, nil
	}
	path, err := exec.LookPath("node")
	if err != nil || strings.TrimSpace(path) == "" {
		return "", fmt.Errorf("node_executable_missing")
	}
	return path, nil
}
