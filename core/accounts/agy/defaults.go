package agy

import (
	"errors"
	"net/url"
	"strings"
	"sync"
)

// DefaultBaseURL 是 agy（Antigravity / Code Assist）官方数据面根地址。
//
// 账号级地址由调用方传入；这里只是进程级兜底，缺省值必须与官方 CLI 一致。
const DefaultBaseURL = "https://daily-cloudcode-pa.googleapis.com/v1internal"

var errInvalidBaseURL = errors.New("必须是绝对 http/https URL，且不含查询串、片段或用户信息")

var (
	defaultBaseURLMu sync.RWMutex
	defaultBaseURL   string
)

// ConfigureDefaultBaseURL 覆盖进程级 agy 上游兜底地址。空值恢复官方默认。
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

// EffectiveDefaultBaseURL 返回进程级兜底地址或官方默认。
func EffectiveDefaultBaseURL() string {
	defaultBaseURLMu.RLock()
	configured := defaultBaseURL
	defaultBaseURLMu.RUnlock()
	if configured != "" {
		return configured
	}
	return DefaultBaseURL
}

// normalizeBaseURL 只接受可用的绝对 http(s) 根地址，并去掉尾部斜杠。
//
// 根地址后面由各调用方自行追加 `:method`，因此不能带查询串、片段或用户信息。
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
