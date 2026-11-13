package egress

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// MacOSClientBundledPaths 列出 macOS 上常见桌面代理客户端自带的 mihomo 内核路径。
var MacOSClientBundledPaths = []string{
	"/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo-alpha",
	"/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo",
	"/Applications/Mihomo Party.app/Contents/Resources/resources/mihomo",
	"/Applications/ClashX Meta.app/Contents/Resources/mihomo",
	"/Applications/ClashX Pro.app/Contents/Resources/mihomo",
}

// WindowsClientBundledPaths 列出 Windows 上常见桌面代理客户端自带的 mihomo 内核路径。
var WindowsClientBundledPaths = []string{
	`C:\Program Files\Clash Verge\verge-mihomo-alpha.exe`,
	`C:\Program Files\Clash Verge\verge-mihomo.exe`,
	`C:\Program Files\Mihomo Party\resources\sidecar\mihomo.exe`,
}

// PathCommandNames 列出 PATH 中常见的 mihomo 可执行文件名。
var PathCommandNames = []string{"mihomo", "clash-meta", "clash"}

// CoreResolution 描述定位到的 mihomo 内核路径与来源。
type CoreResolution struct {
	Path   string `json:"path"`
	Source string `json:"source"` // "managed" | "client" | "path" | "configured"
}

// CoreResolverOptions 允许在单测中注入平台、PATH 与文件探测函数。
type CoreResolverOptions struct {
	AIHomeDir string
	Platform  string
	PathEnv   string
	PathSet   bool
	StatFunc  func(string) (os.FileInfo, error)
}

func mihomoExecutableName(name string, platform string) string {
	switch strings.ToLower(strings.TrimSpace(platform)) {
	case "windows", "win32", "win":
		return name + ".exe"
	default:
		return name
	}
}

func isValidCoreFile(statFn func(string) (os.FileInfo, error), filePath string) bool {
	if strings.TrimSpace(filePath) == "" {
		return false
	}
	info, err := statFn(filePath)
	if err != nil {
		return false
	}
	// 拒绝目录与 0 字节占位文件（Clash Verge 的 verge-mihomo 常见 0 字节占位）。
	return !info.IsDir() && info.Size() > 0
}

// ResolveMihomoCorePath 按优先级定位 mihomo 内核，AIH 不自行下载二进制。
// 优先级：<aiHomeDir>/tools/mihomo -> 已装代理客户端内置内核 -> PATH。
func ResolveMihomoCorePath(opts CoreResolverOptions) (*CoreResolution, error) {
	statFn := opts.StatFunc
	if statFn == nil {
		statFn = os.Stat
	}
	platform := strings.TrimSpace(opts.Platform)
	if platform == "" {
		platform = runtime.GOOS
	}

	aiHomeDir := strings.TrimSpace(opts.AIHomeDir)
	if aiHomeDir != "" {
		managed := filepath.Join(aiHomeDir, "tools", mihomoExecutableName("mihomo", platform))
		if isValidCoreFile(statFn, managed) {
			return &CoreResolution{Path: managed, Source: "managed"}, nil
		}
	}

	bundled := MacOSClientBundledPaths
	if strings.HasPrefix(strings.ToLower(platform), "win") {
		bundled = WindowsClientBundledPaths
	}
	for _, candidate := range bundled {
		if isValidCoreFile(statFn, candidate) {
			return &CoreResolution{Path: candidate, Source: "client"}, nil
		}
	}

	pathEnv := opts.PathEnv
	if !opts.PathSet {
		pathEnv = os.Getenv("PATH")
	}
	for _, name := range PathCommandNames {
		exe := mihomoExecutableName(name, platform)
		for _, dir := range filepath.SplitList(pathEnv) {
			trimmedDir := strings.TrimSpace(dir)
			if trimmedDir == "" {
				continue
			}
			candidate := filepath.Join(trimmedDir, exe)
			if isValidCoreFile(statFn, candidate) {
				return &CoreResolution{Path: candidate, Source: "path"}, nil
			}
		}
	}

	return nil, errors.New("egress_pool_core_not_found")
}
