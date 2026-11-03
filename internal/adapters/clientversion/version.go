// Package clientversion 为网关"模拟客户端"请求解析最新可信的客户端版本。
//
// 背景：Go 自己构造上游请求时（Canonical 编码、模型目录、用量查询）必须自报客户端
// 身份。把版本写死会随客户端自动更新而过时——实测 Codex OAuth /models 按 client_version
// 过滤模型，写死 0.146.0 时 gpt-6-* 永远不可见。本包按优先级合并多个来源并取最大值：
// 显式配置 > 从真实客户端学到的版本 / 本机 CLI 定期探测 > 编译期最低版本。
//
// 只有身份版本跟着变，请求体形状仍由各 Adapter 的编码器决定；版本上涨不代表编码器
// 支持了新版本的协议。原样透传客户端请求的路径（Codex WS、Claude native relay）不用本包，
// 直接跟随真实客户端身份。
package clientversion

import (
	"regexp"
	"strconv"
	"strings"
)

// versionPattern 匹配 semver 版本（可带预发布段），例如 0.158.0-alpha.2.1。
var versionPattern = regexp.MustCompile(`\b(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?\b`)

// Version 是解析后的 semver 版本。
type Version struct {
	major, minor, patch uint64
	prerelease          []string
	raw                 string
}

// Parse 从任意文本（例如 `codex-cli 0.158.0-alpha.2.1`）中提取第一个 semver 版本。
func Parse(text string) (Version, bool) {
	match := versionPattern.FindStringSubmatch(text)
	if match == nil {
		return Version{}, false
	}
	major, _ := strconv.ParseUint(match[1], 10, 64)
	minor, _ := strconv.ParseUint(match[2], 10, 64)
	patch, _ := strconv.ParseUint(match[3], 10, 64)
	version := Version{major: major, minor: minor, patch: patch, raw: match[0]}
	if match[4] != "" {
		version.prerelease = strings.Split(match[4], ".")
	}
	return version, true
}

// MustParse 解析编译期常量版本，非法时 panic。
func MustParse(text string) Version {
	version, ok := Parse(text)
	if !ok || version.raw != text {
		panic("clientversion: invalid version " + text)
	}
	return version
}

// String 返回原始版本文本。
func (version Version) String() string {
	return version.raw
}

// IsZero 判断版本是否未设置。
func (version Version) IsZero() bool {
	return version.raw == ""
}

// Compare 按 semver 2.0 规则比较：预发布版本低于同号正式版本。
func (version Version) Compare(other Version) int {
	for _, pair := range [][2]uint64{
		{version.major, other.major},
		{version.minor, other.minor},
		{version.patch, other.patch},
	} {
		if pair[0] != pair[1] {
			if pair[0] < pair[1] {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(version.prerelease) == 0 && len(other.prerelease) == 0:
		return 0
	case len(version.prerelease) == 0:
		return 1
	case len(other.prerelease) == 0:
		return -1
	}
	for index := 0; index < len(version.prerelease) && index < len(other.prerelease); index++ {
		if result := comparePrereleaseIdentifier(version.prerelease[index], other.prerelease[index]); result != 0 {
			return result
		}
	}
	switch {
	case len(version.prerelease) < len(other.prerelease):
		return -1
	case len(version.prerelease) > len(other.prerelease):
		return 1
	default:
		return 0
	}
}

// comparePrereleaseIdentifier 数字标识按数值比较且低于字母标识，字母标识按 ASCII 比较。
func comparePrereleaseIdentifier(left string, right string) int {
	leftNumber, leftErr := strconv.ParseUint(left, 10, 64)
	rightNumber, rightErr := strconv.ParseUint(right, 10, 64)
	switch {
	case leftErr == nil && rightErr == nil:
		switch {
		case leftNumber < rightNumber:
			return -1
		case leftNumber > rightNumber:
			return 1
		default:
			return 0
		}
	case leftErr == nil:
		return -1
	case rightErr == nil:
		return 1
	default:
		return strings.Compare(left, right)
	}
}

// Max 返回非零版本中的最大值。
func Max(versions ...Version) Version {
	var best Version
	for _, version := range versions {
		if version.IsZero() {
			continue
		}
		if best.IsZero() || version.Compare(best) > 0 {
			best = version
		}
	}
	return best
}
