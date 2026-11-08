package sessionchat

import (
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/madou1217/ai_home/core/providers"
)

// normalizeNodePlatform 把 Go 的平台名与 Node 习惯名归一（windows → win32）。
//
// 空值取当前 GOOS；接受 macos/darwin、windows/win32 两组写法，避免调用方
// 直接传 runtime.GOOS 时 Windows 分支静默失效。
func normalizeNodePlatform(platform string) string {
	normalized := strings.ToLower(strings.TrimSpace(platform))
	if normalized == "" {
		return runtime.GOOS
	}
	switch normalized {
	case "windows":
		return "win32"
	case "macos", "mac":
		return "darwin"
	}
	return normalized
}

// urlPathUnescape 是 decodeURIComponent 的等价实现：解百分号转义，保留 '+'。
func urlPathUnescape(value string) (string, error) {
	return url.PathUnescape(value)
}

// providerCatalog 由 Go Provider 合同构建一次，供账号目录旗标等静态事实查询。
var providerCatalog = sync.OnceValue(func() *providers.Catalog {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return nil
	}
	return catalog
})

// providerConfigDirFlag 返回 Provider 合同声明的账号目录旗标；未声明返回空串。
func providerConfigDirFlag(provider string) string {
	catalog := providerCatalog()
	if catalog == nil {
		return ""
	}
	definition, found := catalog.Get(provider)
	if !found || definition.CLI == nil {
		return ""
	}
	return strings.TrimSpace(definition.CLI.ConfigDirFlag)
}

// stripNestedCodexHome 去掉宿主家目录末尾误带的 /.codex（同 Node stripNestedCodexHome）。
func stripNestedCodexHome(homeDir string) string {
	input := strings.TrimSpace(homeDir)
	if input == "" {
		return ""
	}
	normalized := strings.ReplaceAll(input, "\\", "/")
	normalized = strings.TrimRight(normalized, "/")
	if !strings.HasSuffix(strings.ToLower(normalized), "/.codex") {
		return input
	}
	root := normalized[:len(normalized)-len("/.codex")]
	if root == "" {
		return input
	}
	return root
}

// ResolveHostHomeDir 解析宿主家目录：显式注入 > AIH_HOST_HOME > 平台家目录变量 > os 家目录。
//
// 与 Node resolveHostHomeDir 同优先级；Windows 的私有区编码路径还原（decodeEncodedWindowsPath）
// 未迁移，调用方传入已还原的路径即可。
func ResolveHostHomeDir(injected string, env map[string]string, platform string) string {
	if value := strings.TrimSpace(injected); value != "" {
		return stripNestedCodexHome(value)
	}
	if value := strings.TrimSpace(env["AIH_HOST_HOME"]); value != "" {
		return stripNestedCodexHome(value)
	}
	platform = normalizeNodePlatform(platform)
	if platform == "win32" {
		if value := strings.TrimSpace(env["USERPROFILE"]); value != "" {
			return stripNestedCodexHome(value)
		}
		drive := strings.TrimSpace(env["HOMEDRIVE"])
		path := strings.TrimSpace(env["HOMEPATH"])
		if drive != "" && path != "" {
			return stripNestedCodexHome(drive + path)
		}
	}
	if value := strings.TrimSpace(env["HOME"]); value != "" {
		return stripNestedCodexHome(value)
	}
	if home, err := os.UserHomeDir(); err == nil {
		return stripNestedCodexHome(home)
	}
	return ""
}

// ResolveCLIAuthProjectionDir 解析 CLI 凭据投影目录。
//
// 刻意子集：只有 WorkBuddy 两支追加 cli-home（桌面端 .info 由 Electron 引导加密，
// 独立 CLI 不能共用根目录）；已在 cli-home 下时幂等返回。
func ResolveCLIAuthProjectionDir(projectionDir string, provider string) string {
	root := strings.TrimSpace(projectionDir)
	if root == "" {
		return ""
	}
	normalized := NormalizeProvider(provider)
	if normalized != "workbuddy" && normalized != "workbuddycn" {
		return root
	}
	if filepath.Base(root) == "cli-home" {
		return root
	}
	return filepath.Join(root, "cli-home")
}
