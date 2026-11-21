// Package codexidentity 集中定义网关模拟 Codex 客户端时的身份与版本来源。
//
// 版本不写死：由 clientversion.Resolver 在编译期最低版本、本机 CLI 定期探测与从真实
// Codex 客户端学到的版本中取最大值（见 internal/adapters/clientversion）。
package codexidentity

import (
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/clientversion"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
)

const (
	// Provider 是版本学习存储中的键。
	Provider = "codex"
	// 这里**没有**编译期兜底版本：版本只来自显式配置、本机 CLI 探测或真实客户端
	// 学习。写死的兜底会随官方 CLI 升级而过时（早于目录门槛还会被上游 400 拒绝），
	// 取不到版本时调用方不下发身份头，而不是自报一个假版本。
	// Originator 是网关自报的调用来源；与官方 Codex HTTP Client 默认值一致，只替换版本。
	Originator = "codex_cli_rs"
	// ConfiguredVersionEnv 允许人工锁定版本（与 Node 宿主同名）。
	ConfiguredVersionEnv = "AIH_SERVER_CODEX_CLIENT_VERSION"
	// probeInterval 是本机 CLI 重新探测间隔：Codex CLI 会自动更新。
	probeInterval = time.Hour
)

// codexOriginatorPattern 匹配官方 Codex 客户端的 originator（codex_cli_rs、codex_exec、…）。
var codexOriginatorPattern = regexp.MustCompile(`^codex_[a-z0-9_]{1,48}$`)

// UserAgent 返回网关模拟 Codex 客户端时的 User-Agent。
func UserAgent(version string) string {
	value := strings.TrimSpace(version)
	if value == "" {
		return ""
	}
	return Originator + "/" + value
}

// NewResolver 创建 Codex 客户端版本解析器；learned / probeCache 为 nil 时只在内存中生效。
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

// probeCommands 列出本机可能安装的 Codex CLI：显式路径、PATH 上的 codex，以及
// ChatGPT.app 捆绑的 codex-cli（桌面端常比 PATH 上的独立版更新）。
func probeCommands() []string {
	commands := make([]string, 0, 10)
	if explicit := strings.TrimSpace(os.Getenv("AIH_CODEX_BINARY")); explicit != "" {
		commands = append(commands, explicit)
	}
	if hint := strings.TrimSpace(os.Getenv("AIH_CODEX_DISCOVERED_BINARY")); filepath.IsAbs(hint) {
		commands = append(commands, hint)
	}
	commands = append(commands, "codex")

	// A supervised Linux service often has a deliberately small PATH.  Codex's
	// official installer and the package-manager shims used by aih nevertheless
	// place the executable in these user-level locations.  Keep these candidates
	// here as a standalone Go Core may be launched without the Node resolver that
	// normally supplies AIH_CODEX_BINARY.
	home := strings.TrimSpace(os.Getenv("AIH_HOST_HOME"))
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	if home != "" {
		commands = append(commands,
			filepath.Join(home, ".local", "bin", "codex"),
			filepath.Join(home, providerroot.ConfigDir("codex"), "packages", "standalone", "current", "bin", "codex"),
			filepath.Join(home, ".npm-global", "bin", "codex"),
			filepath.Join(home, ".volta", "bin", "codex"),
			filepath.Join(home, ".local", "share", "pnpm", "codex"),
		)
	}

	// ChatGPT.app is macOS-only, but leaving the explicit candidate in the
	// shared probe list is harmless and preserves desktop installs.
	commands = append(commands,
		"/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
	)
	return commands
}

// VersionFromClientHeaders 从真实 Codex 客户端请求头中提取版本。
//
// 只有 Originator 为 codex_* 且 User-Agent 以 "<originator>/" 开头时才可信，例如
// Codex CLI 0.158.0-alpha.2.1 的 `codex_exec/0.158.0-alpha.2.1 (Mac OS …)`。
func VersionFromClientHeaders(header http.Header) (clientversion.Version, bool) {
	originator := strings.TrimSpace(header.Get("Originator"))
	userAgent := header.Get("User-Agent")
	if !codexOriginatorPattern.MatchString(originator) ||
		!strings.HasPrefix(userAgent, originator+"/") {
		return clientversion.Version{}, false
	}
	token := strings.TrimPrefix(userAgent, originator+"/")
	if space := strings.IndexByte(token, ' '); space >= 0 {
		token = token[:space]
	}
	version, ok := clientversion.Parse(token)
	if !ok || version.String() != token {
		return clientversion.Version{}, false
	}
	return version, true
}
