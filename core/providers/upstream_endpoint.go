package providers

import (
	"net/url"
	"regexp"
	"strings"
)

// Official endpoint facts are shared by egress and canonical account routing.
var officialUpstreamHosts = map[string][]string{
	"codex":       {"api.openai.com"},
	"claude":      {"api.anthropic.com"},
	"gemini":      {"generativelanguage.googleapis.com"},
	"agy":         {"daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"},
	"opencode":    {"opencode.ai"},
	"grok":        {"api.x.ai"},
	"kiro":        {"q.us-east-1.amazonaws.com"},
	"cline":       {"api.cline.bot"},
	"zcode":       {"open.bigmodel.cn", "api.z.ai", "zcode.z.ai"},
	"kimi":        {"api.kimi.com", "api.moonshot.cn", "api.moonshot.ai"},
	"codebuddy":   {"codebuddy.ai"},
	"workbuddy":   {"workbuddy.ai"},
	"codebuddycn": {"copilot.tencent.com"},
	"workbuddycn": {"copilot.tencent.com"},
}

var schemePrefixPattern = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://`)

// ReadUpstreamHost 从用户填写的 base URL 提取小写主机名（允许省略协议）。
func ReadUpstreamHost(baseURL string) string {
	trimmed := strings.TrimSpace(baseURL)
	if trimmed == "" {
		return ""
	}
	withScheme := trimmed
	if !schemePrefixPattern.MatchString(withScheme) {
		withScheme = "https://" + withScheme
	}
	parsed, err := url.Parse(withScheme)
	if err != nil {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(parsed.Hostname()))
}

// ListOfficialUpstreamHosts 返回某 provider 的官方主机清单。
func ListOfficialUpstreamHosts(provider string) []string {
	return append([]string(nil), officialUpstreamHosts[strings.ToLower(strings.TrimSpace(provider))]...)
}

// IsOfficialUpstreamHost 判断主机名是否命中官方主机或其子域。
func IsOfficialUpstreamHost(provider string, host string) bool {
	normalized := strings.ToLower(strings.TrimSpace(host))
	if normalized == "" {
		return false
	}
	for _, official := range ListOfficialUpstreamHosts(provider) {
		if normalized == official || strings.HasSuffix(normalized, "."+official) {
			return true
		}
	}
	return false
}
