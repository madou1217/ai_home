// Package sharedcache 定义"可再生工具链缓存"的宿主重定向。
//
// 账号投影（伪 HOME）里的包管理器缓存默认各存一份：实测一个账号的
// Library/Caches/go-build 就有 2.2G，30+ 账号累计十几 G。这些缓存与账号身份无关，
// 应该全机器一份。Node 启动链（buildSharedCacheEnv）与 Go 的两条启动链
// （桌面 App、原生 CLI 登录）都从这里取同一套变量，避免两边清单漂移。
//
// 不在这里列 XDG_CACHE_HOME：桌面 App 的 Chromium 缓存可能带凭据，由调用方自行决定
// 是否重定向；这里只放工具链/包管理器的定点变量。凭据、会话库永远不在共享范围。
package sharedcache

import (
	"path/filepath"
	"strings"
)

// Env 返回宿主共享缓存的环境变量（hostHomeDir 为空时返回 nil）。
func Env(hostHomeDir, goos string) map[string]string {
	home := strings.TrimSpace(hostHomeDir)
	if home == "" {
		return nil
	}
	cache := filepath.Join(home, ".cache")
	homebrew := filepath.Join(cache, "Homebrew")
	if strings.EqualFold(strings.TrimSpace(goos), "darwin") {
		homebrew = filepath.Join(home, "Library", "Caches", "Homebrew")
	}
	return map[string]string{
		"CARGO_HOME":           filepath.Join(home, ".cargo"),
		"GOPATH":               filepath.Join(home, "go"),
		"GOMODCACHE":           filepath.Join(home, "go", "pkg", "mod"),
		"GOCACHE":              filepath.Join(cache, "go-build"),
		"npm_config_cache":     filepath.Join(home, ".npm"),
		"npm_config_store_dir": filepath.Join(home, ".pnpm-store"),
		"PIP_CACHE_DIR":        filepath.Join(cache, "pip"),
		"UV_CACHE_DIR":         filepath.Join(cache, "uv"),
		"COMPOSER_CACHE_DIR":   filepath.Join(cache, "composer"),
		"HOMEBREW_CACHE":       homebrew,
	}
}
