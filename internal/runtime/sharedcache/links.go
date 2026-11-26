package sharedcache

import "strings"

// Link 是一条「账号投影路径 → 宿主路径」的目录共享。
//
// Takeover 只对纯缓存/工具链产物为 true：投影里若已有历史真实目录，删除后建链；
// 绝不用于可能含凭据的目录（如 .local/share 整体、.config、Library/Application Support）。
type Link struct {
	Projection []string
	Host       []string
	Platforms  []string
	Takeover   bool
}

func platformMatches(link Link, goos string) bool {
	if len(link.Platforms) == 0 {
		return true
	}
	for _, item := range link.Platforms {
		if strings.EqualFold(strings.TrimSpace(item), goos) {
			return true
		}
	}
	return false
}

// Links 返回 fake HOME 默认要链回宿主的工具链/缓存目录。
//
// 这是 CLI 投影、桌面启动、登录链共用的唯一清单：账号只隔离凭据，
// .cache/go/.npm 等与账号无关，必须全机器一份。
//
// 不在这里列 .local/share 整体（Linux 下 CodeBuddy/OpenCode 的 auth 就在里面）、
// .config、Library/Application Support：这些父目录可能含凭据，只能由 Provider
// 策略声明叶子路径或排除项。
func Links(goos string) []Link {
	links := []Link{
		{Projection: []string{".cache"}, Host: []string{".cache"}, Takeover: true},
		{Projection: []string{"go"}, Host: []string{"go"}, Takeover: true},
		{Projection: []string{".npm"}, Host: []string{".npm"}, Takeover: true},
		{Projection: []string{".bun"}, Host: []string{".bun"}, Takeover: true},
		{Projection: []string{".volta"}, Host: []string{".volta"}, Takeover: true},
		{Projection: []string{".cargo"}, Host: []string{".cargo"}, Takeover: true},
		{Projection: []string{".pnpm-store"}, Host: []string{".pnpm-store"}, Takeover: true},
		// 只建链、不接管：状态/命令目录可能含客户端刚写的真实数据。
		{Projection: []string{".local", "bin"}, Host: []string{".local", "bin"}},
		{Projection: []string{".local", "state"}, Host: []string{".local", "state"}},
		// 工具安装体：uv 的 Python、CLI 自更新的版本包，纯缓存，可接管。
		{Projection: []string{".local", "share", "uv"}, Host: []string{".local", "share", "uv"}, Takeover: true},
		{Projection: []string{".local", "share", "claude", "versions"}, Host: []string{".local", "share", "claude", "versions"}, Takeover: true},
		{Projection: []string{".local", "share", "codebuddy", "versions"}, Host: []string{".local", "share", "codebuddy", "versions"}, Takeover: true},
	}
	if goos == "darwin" {
		links = append(links,
			Link{Projection: []string{"Library", "Caches", "go-build"}, Host: []string{"Library", "Caches", "go-build"}, Takeover: true},
			Link{Projection: []string{"Library", "Caches", "Homebrew"}, Host: []string{"Library", "Caches", "Homebrew"}, Takeover: true},
			Link{Projection: []string{"Library", "Caches", "pip"}, Host: []string{"Library", "Caches", "pip"}, Takeover: true},
			Link{Projection: []string{"Library", "Caches", "uv"}, Host: []string{"Library", "Caches", "uv"}, Takeover: true},
		)
	}
	if goos == "windows" {
		// Windows 的 Go/npm/uv/pip 默认位置在 %LOCALAPPDATA%，不在 HOME/.cache。
		links = append(links,
			Link{Projection: []string{"AppData", "Local", "go-build"}, Host: []string{"AppData", "Local", "go-build"}, Takeover: true},
			Link{Projection: []string{"AppData", "Local", "npm-cache"}, Host: []string{"AppData", "Local", "npm-cache"}, Takeover: true},
			Link{Projection: []string{"AppData", "Local", "uv"}, Host: []string{"AppData", "Local", "uv"}, Takeover: true},
			Link{Projection: []string{"AppData", "Local", "pip", "Cache"}, Host: []string{"AppData", "Local", "pip", "Cache"}, Takeover: true},
		)
	}
	out := make([]Link, 0, len(links))
	for _, link := range links {
		if platformMatches(link, goos) {
			out = append(out, link)
		}
	}
	return out
}
