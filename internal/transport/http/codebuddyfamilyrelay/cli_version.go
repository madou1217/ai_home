package codebuddyfamilyrelay

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/clientversion"
)

// cliVersionFloor 是探测失败时自报的版本，与 Node 侧
// CODEBUDDY_FAMILY_CLI_VERSION（lib/account/codebuddy-family-inference.js）同值。
//
// 为什么探测而不是写死：官方 UA / `X-IDE-Version` 带的是当前发行版版本号，
// 写死的常量会随官方升级越来越旧，成为一处可区分的差异。版本号不参与鉴权
// （见 UserAgentFallback 注释），探测失败回退不会造成功能问题。
const cliVersionFloor = "2.63.2"

// UserAgentFallback 是未探测到本机安装版本时的官方同形 UA。
//
// UA 与 `X-IDE-Version` 必须是官方真实客户端标识：脚本默认 UA 会被 WAF 403
// `{"code":10085,"msg":"请求不合法"}`，而版本号本身不参与鉴权与渠道校验
// （code 11128 只看会话 ID 家族，见 ConversationHeaders），所以回退不会造成功能问题。
const UserAgentFallback = "CLI/" + cliVersionFloor + " CodeBuddy/" + cliVersionFloor

// versionCacheTTL 是版本探测结果的缓存时长：官方 CLI 的安装目录只在升级时变化。
const versionCacheTTL = time.Hour

var cliVersionCache struct {
	sync.Mutex
	version string
	expires time.Time
}

// UserAgentFor 返回官方同形的客户端 UA（UA 与 X-IDE-Version 必须同源）。
func UserAgentFor(version string) string {
	value := strings.TrimSpace(version)
	if value == "" {
		value = cliVersionFloor
	}
	return "CLI/" + value + " CodeBuddy/" + value
}

// CLIVersion 返回应自报的 CodeBuddy 家族 CLI 版本：本机安装的最高版本，
// 探测失败时回退编译期常量。UA 与 X-IDE-Version 都从这里取，避免同一次
// 请求里出现两个不同的客户端版本。
func CLIVersion() string {
	cliVersionCache.Lock()
	defer cliVersionCache.Unlock()
	if cliVersionCache.version != "" && time.Now().Before(cliVersionCache.expires) {
		return cliVersionCache.version
	}
	version := detectCLIVersion()
	cliVersionCache.version = version
	cliVersionCache.expires = time.Now().Add(versionCacheTTL)
	return version
}

// detectCLIVersion 读本机安装的官方 CLI 版本（与 Node 侧的探测口径一致）。
func detectCLIVersion() string {
	home := strings.TrimSpace(os.Getenv("AIH_HOST_HOME"))
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	if home == "" {
		return cliVersionFloor
	}
	// 国内站的独立 CLI 发行包用另一个数据根（与 Node 侧 provider-storage-policy 同口径）。
	roots := []string{
		filepath.Join(home, ".local", "share", "codebuddy", "versions"),
		filepath.Join(home, ".codebuddy-cn", "versions"),
	}
	var best clientversion.Version
	for _, root := range roots {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			// 目录名就是版本号；只接受纯 semver，性能与兼容目录（bin/、current 等）都跳过。
			version, ok := clientversion.Parse(entry.Name())
			if !ok || version.String() != entry.Name() {
				continue
			}
			best = clientversion.Max(best, version)
		}
	}
	if best.IsZero() {
		return cliVersionFloor
	}
	return best.String()
}
