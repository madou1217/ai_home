// Package providerruntime 承载 Provider 启动前的纯运行时决策：
// 是否必须投影原生凭据、运行目录、宿主机 home、账号级环境变量的剥离与重设。
//
// 这个包只做纯计算（唯一的系统读取是 os.UserHomeDir 的兜底），不创建目录、不写
// 凭据、不启动进程。真正的投影物化在 application/accountprojection 端口之后由
// runtime adapter 执行。
//
// 行为来源：Node lib/cli/services/ai-cli/provider-runtime-env.js 与
// lib/cli/services/ai-cli/launch-profile/home-redirect-strategy.js。Go 侧原先在
// internal/runtime/providercli/sessionchat/environment.go，P3.0 上移到 application，
// 让 providerlaunch 与 sessionchat 共用同一份决策。
package providerruntime

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/madou1217/ai_home/core/providers"
)

// NormalizeProvider 归一化 Provider 身份：去首尾空白并转小写。
func NormalizeProvider(provider string) string {
	return strings.ToLower(strings.TrimSpace(provider))
}

// NormalizeNodePlatform 把 Go 的平台名与 Node 习惯名归一（windows → win32）。
//
// 空值取当前 GOOS；接受 macos/darwin、windows/win32 两组写法，避免调用方
// 直接传 runtime.GOOS 时 Windows 分支静默失效。
func NormalizeNodePlatform(platform string) string {
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

// providerCatalog 由 Go Provider 合同构建一次，供凭据事实查询。
var providerCatalog = sync.OnceValue(func() *providers.Catalog {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return nil
	}
	return catalog
})

// credentialFactsForProvider 返回 Provider 合同的凭据事实；未知 Provider 返回空事实。
func credentialFactsForProvider(provider string) providers.CredentialFacts {
	catalog := providerCatalog()
	if catalog == nil {
		return providers.CredentialFacts{}
	}
	definition, found := catalog.Get(provider)
	if !found || definition.Credentials == nil {
		return providers.CredentialFacts{}
	}
	return *definition.Credentials
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
// 与 Node resolveHostHomeDir 同优先级；Windows 的私有区编码路径还原
// （decodeEncodedWindowsPath）未迁移，调用方传入已还原的路径即可。
func ResolveHostHomeDir(injected string, env map[string]string, platform string) string {
	if value := strings.TrimSpace(injected); value != "" {
		return stripNestedCodexHome(value)
	}
	if value := strings.TrimSpace(env["AIH_HOST_HOME"]); value != "" {
		return stripNestedCodexHome(value)
	}
	platform = NormalizeNodePlatform(platform)
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

// AuthProjectionOptions 是「是否必须投影原生凭据文件」的输入。
type AuthProjectionOptions struct {
	IsLogin     bool
	Gateway     bool
	AuthRelayed bool
}

// RequiresProviderAuthProjection 判断启动沙箱是否必须投影原生凭据文件。
//
// 登录、原生 OAuth/文件凭据、以及合同声明 cliRequiresAuthFile 的 Provider
// （如 opencode 的 auth.json）一律需要；纯 env 鉴权（密钥/令牌已在 env）不需要。
func RequiresProviderAuthProjection(provider string, accountEnv map[string]string, options AuthProjectionOptions) bool {
	if options.IsLogin {
		return true
	}
	if options.Gateway {
		return false
	}
	if options.AuthRelayed {
		return false
	}
	facts := credentialFactsForProvider(NormalizeProvider(provider))
	if facts.CLIRequiresAuthFile {
		return true
	}
	for _, key := range facts.APIKeyEnv {
		if HasNonEmptyEnvValue(accountEnv, key) {
			return false
		}
	}
	for _, key := range facts.AuthTokenEnv {
		if HasNonEmptyEnvValue(accountEnv, key) {
			return false
		}
	}
	return true
}

// RuntimeScope 是运行时目录与投影需求。
type RuntimeScope struct {
	HostHomeDir        string
	ProjectionRequired bool
	RuntimeDir         string
}

// RuntimeScopeOptions 是运行时作用域解析的输入。
type RuntimeScopeOptions struct {
	AuthProjectionOptions
	// AccountEnv 是本账号要注入的环境（用于判断是否已有 env 鉴权，从而免投影）。
	AccountEnv               map[string]string
	HostHomeDir              string
	Platform                 string
	RelayKeepsAccountSandbox bool
}

// ResolveProviderRuntimeScope 解析宿主家目录、是否投影、以及本次运行目录。
//
// projectionRequired 时运行目录是 Provider 的凭据投影目录；否则在 relay 需要保留沙箱时
// 用投影根，其余情况用宿主家目录（共享配置与会话）。
func ResolveProviderRuntimeScope(provider string, projectionDir string, baseEnv map[string]string, options RuntimeScopeOptions) RuntimeScope {
	candidateDir := strings.TrimSpace(projectionDir)
	hostHomeDir := ResolveHostHomeDir(options.HostHomeDir, baseEnv, options.Platform)
	projectionRequired := RequiresProviderAuthProjection(provider, options.AccountEnv, options.AuthProjectionOptions)
	relayKeepsSandbox := (options.AuthRelayed || options.Gateway) && options.RelayKeepsAccountSandbox
	runtimeDir := hostHomeDir
	if projectionRequired {
		runtimeDir = ResolveCLIAuthProjectionDir(candidateDir, provider)
	} else if relayKeepsSandbox {
		runtimeDir = candidateDir
	}
	return RuntimeScope{
		HostHomeDir:        hostHomeDir,
		ProjectionRequired: projectionRequired,
		RuntimeDir:         runtimeDir,
	}
}
