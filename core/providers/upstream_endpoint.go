package providers

import (
	"net/url"
	"regexp"
	"strings"
	"sync"
)

// builtinCatalog 只构造一次：上游事实由 Provider 合同声明。
var builtinCatalog = sync.OnceValue(func() *Catalog {
	catalog, err := NewCatalog(BuiltinManifest())
	if err != nil {
		return nil
	}
	return catalog
})

// 官方默认推理基址：同一 Provider 的所有消费方（出口裁决、中转通道、额度探测、
// 原生凭据刷新）都从这里取值，避免同一端点在各适配器里各写一份字符串。
//
// 只登记「账号没有自带 baseUrl 时」确实可用的默认值；需要全局覆盖或账号覆盖的
// Provider（gemini / agy / claude / codex）不在这里凭空给默认值。
const (
	// GrokAPIBaseURL 是 xAI 官方 OpenAI 兼容端点。
	GrokAPIBaseURL = "https://api.x.ai/v1"
	// KimiCodeBaseURL 是 Kimi Code（OAuth 登录态）端点。
	KimiCodeBaseURL = "https://api.kimi.com/coding/v1"
	// KimiMoonshotBaseURL 是 Moonshot 公开 API（API Key 账号）端点。
	KimiMoonshotBaseURL = "https://api.moonshot.cn/v1"
	// KiroBaseURL 是 Kiro 的官方推理端点。
	KiroBaseURL = "https://q.us-east-1.amazonaws.com"
	// ZCodeBaseURL 是 ZCode 的 Anthropic 兼容端点（bigmodel 区域）。
	ZCodeBaseURL = "https://open.bigmodel.cn/api/anthropic"
	// ZCodeSiteBaseURL 是 ZCode 站点根：Relay 的 zcode-plan/ultra 端点与计费端点都挂在下面。
	ZCodeSiteBaseURL = "https://zcode.z.ai"
	// ClineBaseURL 是 Cline REST 面（Cline Pass 与 API Key 共用）。
	ClineBaseURL = "https://api.cline.bot/api/v1"
	// CodeBuddyBaseURL 是 CodeBuddy 国际站推理端点。
	CodeBuddyBaseURL = "https://www.codebuddy.ai"
	// WorkBuddyBaseURL 是 WorkBuddy 国际站推理端点。
	WorkBuddyBaseURL = "https://www.workbuddy.ai"
	// TencentCopilotBaseURL 是 CodeBuddy / WorkBuddy 国内站共用推理端点。
	TencentCopilotBaseURL = "https://copilot.tencent.com"
)

// DefaultUpstreamBaseURL 返回 Provider 的官方默认推理基址。
//
// apiKeyMode 用于同一 Provider 存在两套端点的情况：Kimi 的 API Key 账号走
// Moonshot 公开 API，OAuth 账号走 Kimi Code。第二个返回值表示该 Provider 是否
// 声明了默认基址——未声明时必须回落到账号自带 baseUrl 或全局覆盖，不能猜。
func DefaultUpstreamBaseURL(providerID string, apiKeyMode bool) (string, bool) {
	facts, found := UpstreamFacts(providerID)
	if !found || len(facts.DefaultBaseURLs) == 0 {
		return "", false
	}
	mode := "oauth"
	if apiKeyMode {
		mode = "api_key"
	}
	if value := strings.TrimSpace(facts.DefaultBaseURLs[mode]); value != "" {
		return value, true
	}
	if value := strings.TrimSpace(facts.DefaultBaseURLs["default"]); value != "" {
		return value, true
	}
	return "", false
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

// UpstreamFacts 返回 Provider 声明的官方上游事实（防御性副本）。
func UpstreamFacts(providerID string) (Upstream, bool) {
	catalog := builtinCatalog()
	if catalog == nil {
		return Upstream{}, false
	}
	definition, found := catalog.Get(providerID)
	if !found || definition.Upstream == nil {
		return Upstream{}, false
	}
	facts := *definition.Upstream
	facts.OfficialHosts = append([]string(nil), definition.Upstream.OfficialHosts...)
	if definition.Upstream.DefaultBaseURLs != nil {
		facts.DefaultBaseURLs = make(map[string]string, len(definition.Upstream.DefaultBaseURLs))
		for key, value := range definition.Upstream.DefaultBaseURLs {
			facts.DefaultBaseURLs[key] = value
		}
	}
	return facts, true
}

// ListOfficialUpstreamHosts 返回某 provider 的官方主机清单。
func ListOfficialUpstreamHosts(provider string) []string {
	facts, found := UpstreamFacts(provider)
	if !found {
		return nil
	}
	return facts.OfficialHosts
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
