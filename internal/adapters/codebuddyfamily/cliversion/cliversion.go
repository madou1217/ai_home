// Package cliversion 解析本机真实安装的 CodeBuddy 家族 CLI 版本。
//
// 只使用**观测值**：本机安装目录里真实存在的版本，或运维显式配置的值。
// 不提供任何编译期兜底常量——写死的版本会随官方升级越来越旧，成为上游眼里
// 可区分的「非官方客户端」；拿不到版本时宁可不下发版本头，也不自报一个假版本。
package cliversion

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/clientversion"
	codebuddyfamilystorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/codebuddyfamily"
)

const (
	// envOverride 是运维显式锁定的版本（不是写死版本，而是可配置事实）。
	envOverride = "AIH_CODEEBUDDY_CLI_VERSION"
	// cacheTTL 是文件系统探测结果的缓存时长：安装目录只在升级时变化。
	cacheTTL = time.Hour
)

var cache struct {
	sync.Mutex
	version string
	expires time.Time
	loaded  bool
}

// Current 返回应自报的 CLI 版本；无法观测时返回空串。
//
// 空串是合法结果：调用方应据此**不发送**版本头，而不是替换成任何常量。
func Current() string {
	cache.Lock()
	defer cache.Unlock()
	if cache.loaded && time.Now().Before(cache.expires) {
		return cache.version
	}
	cache.version = detect()
	cache.expires = time.Now().Add(cacheTTL)
	cache.loaded = true
	return cache.version
}

// UserAgent 返回官方同形的 UA；版本为空时返回空串（调用方不下发该头）。
//
// 官方 UA 形如 `CLI/<version> CodeBuddy/<version>`，UA 与 X-IDE-Version 必须同源。
func UserAgent(version string) string {
	value := strings.TrimSpace(version)
	if value == "" {
		return ""
	}
	return "CLI/" + value + " CodeBuddy/" + value
}

// detect 按「显式配置 > 本机安装（取最高）」解析版本。
func detect() string {
	if configured := strings.TrimSpace(os.Getenv(envOverride)); configured != "" {
		// 配置值必须自身是干净 semver，避免把非法串当身份发出去。
		if version, ok := clientversion.Parse(configured); ok && version.String() == configured {
			return configured
		}
	}
	return detectInstalled()
}

// detectInstalled 读本机安装的官方 CLI 版本目录名，取最高合法 semver。
//
// 国内站的独立 CLI 发行包用另一个数据根，所以两处都要看。
func detectInstalled() string {
	home := strings.TrimSpace(os.Getenv("AIH_HOST_HOME"))
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	if home == "" {
		return ""
	}
	roots := []string{
		filepath.Join(home, ".local", "share", "codebuddy", "versions"),
	}
	// 国内站 CLI 的版本目录在它自己的配置根下；目录事实由 Provider 合同提供。
	if configDir, ok := codebuddyfamilystorage.ConfigDir("codebuddycn"); ok {
		roots = append(roots, filepath.Join(home, configDir, "versions"))
	}
	var best clientversion.Version
	for _, root := range roots {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			// 目录名就是版本号；bin/current 之类的兼容目录不是 semver，跳过。
			version, ok := clientversion.Parse(entry.Name())
			if !ok || version.String() != entry.Name() {
				continue
			}
			best = clientversion.Max(best, version)
		}
	}
	if best.IsZero() {
		return ""
	}
	return best.String()
}
