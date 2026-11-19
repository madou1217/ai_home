package gemini

import (
	"errors"
	"net/url"
	"strings"
	"sync"
)

const (
	// DefaultCodeAssistBaseURL 是 Gemini CLI 登录态（OAuth）的 Code Assist 数据面。
	DefaultCodeAssistBaseURL = "https://cloudcode-pa.googleapis.com/v1internal"
	// DefaultAPIKeyBaseURL 是 API Key 账号的 Gemini 原生 REST 面。
	DefaultAPIKeyBaseURL = "https://generativelanguage.googleapis.com/v1beta"
)

var errInvalidBaseURL = errors.New("必须是绝对 http/https URL，且不含查询串、片段或用户信息")

var (
	defaultBaseURLMu sync.RWMutex
	defaultBaseURL   string
)

// ConfigureDefaultBaseURL 覆盖进程级 Gemini 上游兜底地址。空值恢复官方默认。
func ConfigureDefaultBaseURL(raw string) error {
	if raw == "" {
		defaultBaseURLMu.Lock()
		defaultBaseURL = ""
		defaultBaseURLMu.Unlock()
		return nil
	}
	normalized, err := normalizeBaseURL(raw)
	if err != nil {
		return err
	}
	defaultBaseURLMu.Lock()
	defaultBaseURL = normalized
	defaultBaseURLMu.Unlock()
	return nil
}

// EffectiveCodeAssistBaseURL 返回登录态 Code Assist 的根地址。
//
// 与 Node normalizeGeminiBaseUrl 同口径：未配置、或配置值就是 API Key 的官方
// 默认面时，登录态账号仍走 Code Assist 官方数据面；其它显式配置整体生效。
func EffectiveCodeAssistBaseURL() string {
	configured := configuredDefaultBaseURL()
	if configured == "" || configured == DefaultAPIKeyBaseURL {
		return DefaultCodeAssistBaseURL
	}
	return configured
}

// EffectiveAPIKeyBaseURL 返回 API Key 账号的根地址。
func EffectiveAPIKeyBaseURL() string {
	if configured := configuredDefaultBaseURL(); configured != "" {
		return configured
	}
	return DefaultAPIKeyBaseURL
}

func configuredDefaultBaseURL() string {
	defaultBaseURLMu.RLock()
	defer defaultBaseURLMu.RUnlock()
	return defaultBaseURL
}

// normalizeBaseURL 只接受可用的绝对 http(s) 根地址，并去掉尾部斜杠。
func normalizeBaseURL(raw string) (string, error) {
	value := strings.TrimRight(strings.TrimSpace(raw), "/")
	if value == "" {
		return "", errInvalidBaseURL
	}
	if strings.ContainsAny(value, " \t\r\n") || strings.Contains(value, "#") {
		return "", errInvalidBaseURL
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Opaque != "" || parsed.Host == "" || parsed.User != nil {
		return "", errInvalidBaseURL
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", errInvalidBaseURL
	}
	if parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || parsed.RawFragment != "" {
		return "", errInvalidBaseURL
	}
	if strings.ToLower(parsed.Hostname()) == "" {
		return "", errInvalidBaseURL
	}
	return scheme + "://" + parsed.Host + strings.TrimRight(parsed.EscapedPath(), "/"), nil
}
