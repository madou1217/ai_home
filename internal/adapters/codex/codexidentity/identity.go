// Package codexidentity 集中定义网关模拟 Codex 客户端时的身份与版本来源。
//
// 版本不写死：由 clientversion.Resolver 在编译期最低版本、本机 CLI 定期探测与从真实
// Codex 客户端学到的版本中取最大值（见 internal/adapters/clientversion）。
package codexidentity

import (
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/clientversion"
)

const (
	// Provider 是版本学习存储中的键。
	Provider = "codex"
	// Floor 是编译期最低版本：Go 的 Codex 编码器已按 Codex CLI 0.158.0-alpha.2.1 的真实请求
	// （Responses Lite、freeform 工具）验证；gpt-6-* 需要不低于该代的 client_version 才会出现在
	// OAuth 模型目录中。只作下限，实际版本随 CLI 与真实客户端上涨。
	Floor = "0.158.0"
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
	if version == "" {
		version = Floor
	}
	return Originator + "/" + version
}

// NewResolver 创建 Codex 客户端版本解析器；learned 为 nil 时只在内存中学习。
func NewResolver(learned *clientversion.LearnedStore) (*clientversion.Resolver, error) {
	return clientversion.NewResolver(clientversion.ResolverOptions{
		Provider:      Provider,
		Floor:         Floor,
		Configured:    os.Getenv(ConfiguredVersionEnv),
		ProbeCommands: probeCommands(),
		ProbeInterval: probeInterval,
		Learned:       learned,
	})
}

// probeCommands 列出本机可能安装的 Codex CLI：显式路径、PATH 上的 codex，以及
// ChatGPT.app 捆绑的 codex-cli（桌面端常比 PATH 上的独立版更新）。
func probeCommands() []string {
	commands := make([]string, 0, 3)
	if explicit := strings.TrimSpace(os.Getenv("AIH_CODEX_BIN")); explicit != "" {
		commands = append(commands, explicit)
	}
	commands = append(commands,
		"codex",
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
