package applaunch

import (
	"context"
	"encoding/json"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/madou1217/ai_home/application/launcher"
)

// ProxyMode 描述一个应用接受代理的方式。
//
// 不是所有应用都能被代理：Chromium 系浏览器必须用 --proxy-server；其它应用
// 只能继承 HTTP(S)_PROXY 环境变量，是否生效取决于应用自身。把这个事实显式
// 暴露给 CLI / WebUI，避免把「启动成功」说成「代理生效」。
type ProxyMode string

const (
	// ProxyModeChromium 通过浏览器启动参数挂代理（可靠）。
	ProxyModeChromium ProxyMode = "chromium"
	// ProxyModeEnvironment 通过进程环境变量挂代理（尽力，应用可能忽略）。
	ProxyModeEnvironment ProxyMode = "environment"
)

// Label 返回给用户看的中文能力说明。
func (mode ProxyMode) Label() string {
	switch mode {
	case ProxyModeChromium:
		return "浏览器参数"
	case ProxyModeEnvironment:
		return "环境变量（尽力）"
	default:
		return string(mode)
	}
}

// ProxyOptions 描述一次带代理的启动。
type ProxyOptions struct {
	// URL 是代理入口，例如 http://127.0.0.1:6152。
	URL string
	// AIHomeDir 决定 Chromium 独立 profile 的存放位置。
	AIHomeDir string
	// ProfileDir 可覆盖独立 profile 目录；为空时按应用名与端口派生。
	ProfileDir string
	// ExtraArgs 仅对 Chromium 系生效，追加在代理参数之后。
	ExtraArgs []string
	// Independent 强制启动独立实例（即使没有代理）。看台需要可追踪的进程，
	// 复用已有实例会拿到一个启动前就存在的 PID。
	Independent bool
	// Sandbox requests the macOS sandbox-exec launcher (Chromium/Electron).
	Sandbox bool
}

// ProxyModeFor 判定应用的代理能力。
func ProxyModeFor(app launcher.App) ProxyMode {
	haystack := strings.ToLower(strings.Join([]string{
		app.Name,
		app.Path,
		strings.Join(app.Aliases, " "),
	}, " "))
	for _, marker := range []string{
		"google chrome",
		"microsoft edge",
		"msedge",
		"brave browser",
		"chromium",
		"vivaldi",
		"opera",
	} {
		if strings.Contains(haystack, marker) {
			return ProxyModeChromium
		}
	}
	return ProxyModeEnvironment
}

// OpenWithProxy 启动一个独立实例并注入本次进程的代理。
//
// URL 为空时退化为普通启动，返回应用自身的代理能力供调用方展示。
func OpenWithProxy(ctx context.Context, app launcher.App, options ProxyOptions) (ProxyMode, error) {
	mode := ProxyModeFor(app)
	proxyURL := strings.TrimSpace(options.URL)
	if proxyURL == "" && !options.Independent {
		return mode, New().Open(ctx, app)
	}
	if mode == ProxyModeChromium && proxyURL != "" && strings.TrimSpace(options.ProfileDir) == "" {
		options.ProfileDir = defaultChromiumProfile(app, proxyURL, options.AIHomeDir)
	}
	return mode, openWithProxy(ctx, app, mode, proxyURL, options)
}

// ProfileDir returns the isolated browser profile used by a proxied launch.
// Non-Chromium apps and empty proxy URLs return "".
func ProfileDir(app launcher.App, proxyURL, aiHomeDir string) string {
	proxyURL = strings.TrimSpace(proxyURL)
	if proxyURL == "" || ProxyModeFor(app) != ProxyModeChromium {
		return ""
	}
	return defaultChromiumProfile(app, proxyURL, aiHomeDir)
}

// OpenWithProxy 与包级函数同义，供依赖注入的 Launcher 端口使用。
func (l *Launcher) OpenWithProxy(ctx context.Context, app launcher.App, options ProxyOptions) (ProxyMode, error) {
	return OpenWithProxy(ctx, app, options)
}

// ProxyEnvironment 返回本次启动注入的代理环境变量；大小写两套都写入，
// 因为不同工具链读取不同的变量名。
func ProxyEnvironment(proxyURL string) map[string]string {
	proxyURL = strings.TrimSpace(proxyURL)
	if proxyURL == "" {
		return nil
	}
	bypass := "127.0.0.1,localhost,::1"
	return map[string]string{
		"HTTP_PROXY":  proxyURL,
		"HTTPS_PROXY": proxyURL,
		"ALL_PROXY":   proxyURL,
		"NO_PROXY":    bypass,
		"http_proxy":  proxyURL,
		"https_proxy": proxyURL,
		"all_proxy":   proxyURL,
		"no_proxy":    bypass,
	}
}

// DefaultProxyURL 返回本机应用代理应使用的地址：匿名入口 6152 优先，
// 其次读取常驻入口发布文件。入口文件可能由旧会话写入，因此先探测端口。
func DefaultProxyURL(aiHomeDir string) string {
	defaultURL := "http://127.0.0.1:6152"
	if proxyURLReachable(defaultURL) {
		return defaultURL
	}
	home := strings.TrimSpace(aiHomeDir)
	if home == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			return defaultURL
		}
		home = filepath.Join(userHome, ".ai_home")
	}
	raw, err := os.ReadFile(filepath.Join(home, "run", "proxy", "entry.json"))
	if err == nil {
		var entry struct {
			HTTPURL string `json:"httpUrl"`
		}
		if json.Unmarshal(raw, &entry) == nil && proxyURLReachable(entry.HTTPURL) {
			return strings.TrimSpace(entry.HTTPURL)
		}
	}
	return defaultURL
}

func proxyURLReachable(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" {
		return false
	}
	connection, err := net.DialTimeout("tcp", parsed.Host, 300*time.Millisecond)
	if err != nil {
		return false
	}
	_ = connection.Close()
	return true
}

func defaultChromiumProfile(app launcher.App, proxyURL, aiHomeDir string) string {
	home := strings.TrimSpace(aiHomeDir)
	if home == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		home = filepath.Join(userHome, ".ai_home")
	}
	port := "proxy"
	if index := strings.LastIndex(proxyURL, ":"); index >= 0 {
		port = strings.Trim(proxyURL[index+1:], "/")
	}
	slug := slugForApp(app)
	return filepath.Join(home, "run", "app-proxy", slug+"-"+port)
}

func slugForApp(app launcher.App) string {
	candidate := strings.TrimSpace(app.Name)
	if candidate == "" {
		candidate = filepath.Base(strings.TrimSpace(app.Path))
	}
	var builder strings.Builder
	for _, runeValue := range strings.ToLower(candidate) {
		switch {
		case unicode.IsLetter(runeValue), unicode.IsDigit(runeValue):
			builder.WriteRune(runeValue)
		case runeValue == '-', runeValue == '_':
			builder.WriteRune(runeValue)
		default:
			builder.WriteByte('-')
		}
	}
	slug := strings.Trim(builder.String(), "-")
	if slug == "" {
		return "app"
	}
	return slug
}

// chromiumArguments 是 Chromium 系浏览器的代理参数；独立 profile 是必需的，
// 否则已有实例会接管启动并把参数丢掉。
func chromiumArguments(proxyURL, profileDir string, extra []string) []string {
	args := []string{
		"--proxy-server=" + proxyURL,
		"--proxy-bypass-list=127.0.0.1;localhost;::1",
	}
	if profileDir != "" {
		args = append(args, "--user-data-dir="+profileDir)
	}
	return append(args, extra...)
}

func ensureProfileDir(path string) error {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	return os.MkdirAll(path, 0o700)
}
