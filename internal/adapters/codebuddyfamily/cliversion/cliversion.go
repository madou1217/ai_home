// Package cliversion 解析本机真实安装的 CodeBuddy 家族 CLI 版本。
//
// 只使用**观测值**：本机安装目录里真实存在的版本，或运维显式配置的值。
// 不提供任何编译期兜底常量——写死的版本会随官方升级越来越旧，成为上游眼里
// 可区分的「非官方客户端」；拿不到版本时宁可不下发版本头，也不自报一个假版本。
package cliversion

import (
	"context"
	"os"
	"os/exec"
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
	// envBinaryOverride 显式指定要探测的官方 CLI 二进制（安装器/运维使用）。
	envBinaryOverride = "AIH_CODEEBUDDY_BINARY"
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

// detect 按「显式配置 > 二进制自报 > 本机安装目录（取最高）」解析版本。
//
// 二进制自报优先于目录名：官方安装目录可能停留在旧版本（例如目录叫
// 2.178.1，二进制实际是 2.187.0），只读目录会把旧版本当成当前身份发给上游。
func detect() string {
	if configured := strings.TrimSpace(os.Getenv(envOverride)); configured != "" {
		// 配置值必须自身是干净 semver，避免把非法串当身份发出去。
		if version, ok := clientversion.Parse(configured); ok && version.String() == configured {
			return configured
		}
	}
	if version := detectBinaryVersion(); version != "" {
		return version
	}
	return detectInstalled()
}

// detectBinaryVersion 运行官方 CLI 的 --version，返回它真实自报的版本。
//
// 只用于读版本，不触网；超时 3s。路径全部来自固定安装位置或显式覆盖，
// 不接受用户输入。失败时返回空串，由目录探测兜底。
func detectBinaryVersion() string {
	candidates := make([]string, 0, 6)
	if configured := strings.TrimSpace(os.Getenv(envBinaryOverride)); configured != "" {
		candidates = append(candidates, configured)
	}
	home := strings.TrimSpace(os.Getenv("AIH_HOST_HOME"))
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	if home != "" {
		candidates = append(candidates,
			filepath.Join(home, ".local", "bin", "codebuddy"),
			filepath.Join(home, ".local", "share", "codebuddy", "bin", "codebuddy"),
			filepath.Join(home, ".codebuddy-cn", "bin", "codebuddy"),
		)
	}
	candidates = append(candidates,
		"/opt/homebrew/bin/codebuddy",
		"/usr/local/bin/codebuddy",
	)
	for _, candidate := range candidates {
		path := strings.TrimSpace(candidate)
		if path == "" {
			continue
		}
		if info, err := os.Stat(path); err != nil || info.IsDir() {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		output, err := exec.CommandContext(ctx, path, "--version").Output()
		cancel()
		if err != nil {
			continue
		}
		version := strings.TrimSpace(string(output))
		if line, _, ok := strings.Cut(version, "\n"); ok {
			version = strings.TrimSpace(line)
		}
		if parsed, ok := clientversion.Parse(version); ok && parsed.String() == version {
			return version
		}
	}
	return ""
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
