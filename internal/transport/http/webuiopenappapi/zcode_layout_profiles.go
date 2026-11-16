package webuiopenappapi

// ZCode 桌面端的布局画像：不同版本把 Agent 解析代码放在不同目录，且未来还可能变化。
// 这里用「版本区间 → 布局」的注册表，而不是把目录写死在补丁逻辑里。
//
// 3.16 / 3.17：Agent 命令解析在 out/main/index.js（旧布局）。
// 3.18+      ：解析搬到 out/host/chunk-*.js；out/main 仍保留兜底。
// 未知版本    ：自动搜索两套布局，优先新布局。

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

type zcodeLayoutProfile struct {
	// ID 是稳定画像名，会进入影子 App 指纹，保证不同版本并存互不覆盖。
	ID string
	// AgentDirs 是 Agent 补丁锚点的搜索目录，按顺序尝试。
	AgentDirs []string
	// Description 只用于诊断日志/文档。
	Description string
}

var (
	zcodeLegacyLayout = zcodeLayoutProfile{
		ID:          "zcode-316-317-main",
		AgentDirs:   []string{"out/main/"},
		Description: "ZCode 3.16/3.17: agent resolver in out/main",
	}
	zcodeHostLayout = zcodeLayoutProfile{
		ID:          "zcode-318-host",
		AgentDirs:   []string{"out/host/", "out/main/"},
		Description: "ZCode 3.18+: agent resolver in out/host, out/main fallback",
	}
	zcodeAutoLayout = zcodeLayoutProfile{
		ID:          "zcode-auto",
		AgentDirs:   []string{"out/host/", "out/main/"},
		Description: "unknown version: search both layouts",
	}
)

var zcodePlistVersionPattern = regexp.MustCompile("(?s)<key>CFBundleShortVersionString</key>\\s*<string>([^<]+)</string>")

// matchZcodeLayoutProfile 按 App 版本选择布局画像。
func matchZcodeLayoutProfile(version string) zcodeLayoutProfile {
	major, minor, ok := parseZcodeVersion(version)
	if !ok {
		return zcodeAutoLayout
	}
	if major > 3 || (major == 3 && minor >= 18) {
		return zcodeHostLayout
	}
	if major == 3 && minor >= 16 {
		return zcodeLegacyLayout
	}
	return zcodeAutoLayout
}

// readZcodeAppVersion 从 App bundle 的 Info.plist 读取真实版本；读不到返回空串。
func readZcodeAppVersion(bundlePath string) string {
	plistPath := filepath.Join(bundlePath, "Contents", "Info.plist")
	payload, err := os.ReadFile(plistPath)
	if err != nil {
		return ""
	}
	match := zcodePlistVersionPattern.FindSubmatch(payload)
	if len(match) != 2 {
		return ""
	}
	return strings.TrimSpace(string(match[1]))
}

func parseZcodeVersion(version string) (int, int, bool) {
	trimmed := strings.TrimSpace(strings.TrimPrefix(version, "v"))
	parts := strings.Split(trimmed, ".")
	if len(parts) < 2 {
		return 0, 0, false
	}
	major, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, false
	}
	minor, err := strconv.Atoi(parts[1])
	if err != nil {
		return 0, 0, false
	}
	return major, minor, true
}
