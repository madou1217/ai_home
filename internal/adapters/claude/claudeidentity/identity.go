// Package claudeidentity 集中定义网关模拟 Claude Code 客户端时的身份与版本来源。
//
// 版本不写死：由 clientversion.Resolver 在编译期最低版本、本机 CLI 定期探测与从真实
// Claude Code 客户端学到的版本中取最大值（见 internal/adapters/clientversion）。
// 订阅 OAuth 的请求合同按客户端身份判定，版本写死会随官方 CLI 自动更新而过时。
package claudeidentity

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/clientversion"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
)

const (
	// Provider 是版本学习存储中的键。
	Provider = "claude"
	// 这里**没有**编译期兜底版本：版本只来自显式配置、本机 CLI 探测或真实客户端
	// 学习。写死的兜底会随官方 CLI 升级而过时，成为上游眼里可区分的「非官方客户端」；
	// 取不到版本时调用方不下发版本头，而不是自报一个假版本。
	// Product 是官方 CLI User-Agent 里的产品名。
	Product = "claude-cli"
	// SDKMarker 是官方 CLI 在 User-Agent 末尾自报的运行形态。
	SDKMarker = " (external, sdk-cli)"
	// ConfiguredVersionEnv 允许人工锁定版本（与 Node 宿主同名）。
	ConfiguredVersionEnv = "AIH_SERVER_CLAUDE_CLIENT_VERSION"
	// probeInterval 是本机 CLI 重新探测间隔：Claude Code 会自动更新。
	probeInterval = time.Hour
)

// productPrefixes 是可信客户端 User-Agent 可能使用的产品名前缀。
//
// 官方 CLI 自报 claude-cli；早期构建与部分嵌入方仍用 claude-code。
var productPrefixes = []string{Product + "/", "claude-code/"}

// UserAgent 返回网关模拟 Claude Code 客户端时的 User-Agent。
//
// 版本为空时返回空串：调用方据此**不下发**该 Header，而不是填一个写死的版本。
func UserAgent(version string) string {
	value := strings.TrimSpace(version)
	if value == "" {
		return ""
	}
	return Product + "/" + value + SDKMarker
}

// NewResolver 创建 Claude 客户端版本解析器；learned / probeCache 为 nil 时只在内存中生效。
func NewResolver(learned *clientversion.LearnedStore, probeCache *clientversion.ProbeCache) (*clientversion.Resolver, error) {
	return clientversion.NewResolver(clientversion.ResolverOptions{
		Provider:      Provider,
		Configured:    os.Getenv(ConfiguredVersionEnv),
		ProbeCommands: probeCommands(),
		ProbeInterval: probeInterval,
		Learned:       learned,
		ProbeCache:    probeCache,
	})
}

// probeCommands 列出本机可能安装的 Claude Code CLI：显式路径、PATH 上的
// claude / claude-code，以及官方安装器与包管理器常用的用户级位置。
func probeCommands() []string {
	commands := make([]string, 0, 12)
	if explicit := strings.TrimSpace(os.Getenv("AIH_CLAUDE_BINARY")); explicit != "" {
		commands = append(commands, explicit)
	}
	commands = append(commands, "claude", "claude-code")

	home := strings.TrimSpace(os.Getenv("AIH_HOST_HOME"))
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	if home != "" {
		commands = append(commands,
			filepath.Join(home, ".local", "bin", "claude"),
			filepath.Join(home, providerroot.ConfigDir("claude"), "local", "claude"),
			filepath.Join(home, ".npm-global", "bin", "claude"),
			filepath.Join(home, ".bun", "bin", "claude"),
			filepath.Join(home, ".volta", "bin", "claude"),
		)
	}
	commands = append(commands,
		"/usr/local/bin/claude",
		"/opt/homebrew/bin/claude",
	)
	return commands
}

// VersionFromClientHeaders 从真实 Claude Code 客户端请求头中提取版本。
//
// 官方 CLI 的 User-Agent 形如 `claude-cli/2.1.328 (external, sdk-cli)`；只接受已知
// 产品名前缀，未鉴权请求伪造的任意 UA 不能抬高网关自报的身份。
func VersionFromClientHeaders(header http.Header) (clientversion.Version, bool) {
	userAgent := strings.TrimSpace(header.Get("User-Agent"))
	for _, prefix := range productPrefixes {
		if !strings.HasPrefix(userAgent, prefix) {
			continue
		}
		token := strings.TrimPrefix(userAgent, prefix)
		if space := strings.IndexByte(token, ' '); space >= 0 {
			token = token[:space]
		}
		version, ok := clientversion.Parse(token)
		if !ok || version.String() != token {
			return clientversion.Version{}, false
		}
		return version, true
	}
	return clientversion.Version{}, false
}
