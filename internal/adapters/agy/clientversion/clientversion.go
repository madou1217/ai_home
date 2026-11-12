// Package clientversion 探测 Antigravity 客户端版本。
//
// 顺序：AIH_AGY_USAGE.clientVersion → 本机安装包 → 上次远程探测缓存 → 远程最新版。
// Google 对客户端版本做白名单校验，1.x 与部分 2.x 版本会直接返回
// "This version of Antigravity is no longer supported"，所以不能长期写死版本号。
// 版本用于 User-Agent / x-client-version（code-assist 与额度采集共用）。
package clientversion

import (
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Default 只在「本机没有安装、缓存为空、远程也读不到」时兜底。
// 正常路径是远程下载页的最新版本（refreshRemote 异步刷新）。
const Default = "2.6.0"

const (
	usageEnv       = "AIH_AGY_USAGE"
	appInfoPlist   = "/Applications/Antigravity.app/Contents/Info.plist"
	downloadPage   = "https://antigravity.google/download"
	versionPattern = `[0-9]+[.][0-9]+[.][0-9]+`
)

var (
	once     sync.Once
	current  atomic.Value
	pageLink = regexp.MustCompile(`v([0-9]+[.][0-9]+[.][0-9]+)`)
)

// Detect 返回当前客户端版本；进程内只初始化一次，远程最新版异步刷新。
func Detect() string {
	once.Do(func() {
		value := detectLocal()
		if value == "" {
			value = readCachedVersion()
		}
		if value == "" {
			value = Default
		}
		current.Store(value)
		go refreshRemote()
	})
	if value, ok := current.Load().(string); ok && value != "" {
		return value
	}
	return Default
}

// DetectFrom 是纯函数版本，便于测试注入环境值与 plist 路径。
func DetectFrom(usageValue string, plistPath string) string {
	if value := detectFrom(usageValue, plistPath); value != "" {
		return value
	}
	return Default
}

func detectLocal() string {
	return detectFrom(os.Getenv(usageEnv), appInfoPlist)
}

func detectFrom(usageValue string, plistPath string) string {
	if value := parseVersion(endpointField(usageValue, "clientVersion")); value != "" {
		return value
	}
	return parseVersion(readPlistVersion(plistPath))
}

// refreshRemote 从官方下载页取最新版本；失败静默保留当前值。
func refreshRemote() {
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Get(downloadPage)
	if err != nil {
		return
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return
	}
	value := latestVersionFromPage(string(body))
	if value == "" {
		return
	}
	current.Store(value)
	writeCachedVersion(value)
}

// latestVersionFromPage 取页面里 major >= 2 的最大版本。
// 下载页同时列出 IDE/CLI/各扩展的版本，CLI 1.x 不能被选中。
func latestVersionFromPage(page string) string {
	best := ""
	for _, match := range pageLink.FindAllStringSubmatch(page, -1) {
		candidate := match[1]
		if compareVersion(candidate, "2.0.0") < 0 {
			continue
		}
		if best == "" || compareVersion(candidate, best) > 0 {
			best = candidate
		}
	}
	return best
}

func compareVersion(left string, right string) int {
	leftParts := strings.Split(left, ".")
	rightParts := strings.Split(right, ".")
	for index := 0; index < 3; index += 1 {
		leftValue := versionPart(leftParts, index)
		rightValue := versionPart(rightParts, index)
		if leftValue != rightValue {
			if leftValue > rightValue {
				return 1
			}
			return -1
		}
	}
	return 0
}

func versionPart(parts []string, index int) int {
	if index >= len(parts) {
		return 0
	}
	value, _ := strconv.Atoi(parts[index])
	return value
}

// cacheFilePath 返回上次远程版本的落盘点；没有用户缓存目录时返回空串。
func cacheFilePath() string {
	directory, err := os.UserCacheDir()
	if err != nil || strings.TrimSpace(directory) == "" {
		return ""
	}
	return filepath.Join(directory, "aih", "agy-client-version")
}

func readCachedVersion() string {
	path := cacheFilePath()
	if path == "" {
		return ""
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return parseVersion(string(raw))
}

func writeCachedVersion(value string) {
	path := cacheFilePath()
	if path == "" || strings.TrimSpace(value) == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return
	}
	_ = os.WriteFile(path, []byte(value), 0o600)
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
		if decoded, err := url.QueryUnescape(value); err == nil {
			return decoded
		}
		return value
	}
	return ""
}

// readPlistVersion 用文本匹配读 CFBundleShortVersionString。
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

// parseVersion 只接受纯 x.y.z；其它形态视为不可用。
func parseVersion(value string) string {
	text := strings.TrimSpace(value)
	match := regexp.MustCompile(versionPattern).FindString(text)
	if match == "" || !semanticVersion.MatchString(match) {
		return ""
	}
	return match
}
