// Package clientversion 探测 Antigravity 客户端版本。
//
// Node 来源：lib/server/antigravity-version.js + lib/usage/agy-endpoints.js。
// 顺序：AIH_AGY_USAGE 里的 clientVersion → 安装包 Info.plist → 编译期默认值。
// 版本用于 User-Agent / x-client-version（code-assist 与额度采集共用）。
package clientversion

import (
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
)

// Default 是探测不到时使用的版本（与迁移前硬编码值一致）。
const Default = "1.15.8"

const (
	usageEnv       = "AIH_AGY_USAGE"
	appInfoPlist   = "/Applications/Antigravity.app/Contents/Info.plist"
	versionPattern = `[0-9]+[.][0-9]+[.][0-9]+`
)

var (
	once    sync.Once
	version string
)

// Detect 返回缓存的客户端版本；进程内只探测一次。
func Detect() string {
	once.Do(func() {
		version = DetectFrom(os.Getenv(usageEnv), appInfoPlist)
	})
	return version
}

// DetectFrom 是纯函数版本，便于测试注入环境值与 plist 路径。
func DetectFrom(usageValue string, plistPath string) string {
	if value := parseVersion(endpointField(usageValue, "clientVersion")); value != "" {
		return value
	}
	if value := parseVersion(readPlistVersion(plistPath)); value != "" {
		return value
	}
	return Default
}

// endpointField 解析 Node 的 AIH_AGY_USAGE 逗号分隔 key=value 字段。
func endpointField(raw string, key string) string {
	for _, part := range strings.Split(raw, ",") {
		index := strings.Index(part, "=")
		if index <= 0 {
			continue
		}
		if strings.TrimSpace(part[:index]) != key {
			continue
		}
		value := strings.TrimSpace(part[index+1:])
		if value == "" {
			continue
		}
		// Node 用 decodeURIComponent；解码失败保留原值。
		if decoded, err := url.QueryUnescape(value); err == nil {
			return decoded
		}
		return value
	}
	return ""
}

// readPlistVersion 用文本匹配读 CFBundleShortVersionString。
//
// 不依赖 PlistBuddy：探测发生在请求热路径的初始化阶段，少一个子进程更稳。
func readPlistVersion(path string) string {
	if strings.TrimSpace(path) == "" {
		return ""
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	match := regexp.MustCompile(
		`<key>CFBundleShortVersionString</key>[[:space:]]*<string>([^<]+)</string>`,
	).FindSubmatch(raw)
	if len(match) < 2 {
		return ""
	}
	return string(match[1])
}

var semanticVersion = regexp.MustCompile("^" + versionPattern + "$")

// parseVersion 只接受纯 x.y.z；其它形态视为不可用（Node 同样用正则提取）。
func parseVersion(value string) string {
	text := strings.TrimSpace(value)
	match := regexp.MustCompile(versionPattern).FindString(text)
	if match == "" || !semanticVersion.MatchString(match) {
		return ""
	}
	return match
}
