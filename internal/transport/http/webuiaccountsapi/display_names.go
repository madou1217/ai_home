package webuiaccountsapi

import (
	"net/url"
	"regexp"
	"strings"
)

// DisplayName 是账号页可轮播的一个身份项。
//
// 字段名与账号页契约一致（type / value）；数组顺序就是前端轮播顺序：
// 邮箱 → 手机号 → 昵称（API Key 账号用 name）。新增身份类型只加一项，不改结构。
type DisplayName struct {
	Type  string `json:"type"`
	Value string `json:"value"`
}

var (
	emailDisplayValuePattern   = regexp.MustCompile("^[^@\\s]+@[^@\\s]+$")
	syntheticPhonePattern      = regexp.MustCompile("(?i)^(\\d{6,})@phone\\.local$")
	opaqueUUIDPattern          = regexp.MustCompile("(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
	providerLabelSuffixPattern = regexp.MustCompile("^([A-Za-z][A-Za-z0-9 ._-]{1,32}?)\\s*(?:API|CLI)?\\s*[（(][^)）]{1,40}[)）]$")
	providerTokenReplacer      = strings.NewReplacer(" ", "", "\t", "", "\n", "", "_", "", "-", "")
)

// buildDisplayNames 从账号行事实派生可轮播身份列表。
//
// 规则与账号页的展示口径一致：
//   - 邮箱优先；`<phone>@phone.local` 这类合成邮箱只保留手机号；
//   - API Key 账号没有昵称，展示名（端点域名/标签）用 name；
//   - OAuth 账号按邮箱 / 昵称归类，过滤内部编号与无身份价值的 Provider 标签；
//   - 身份全被过滤时用原始展示名兜底，绝不产出空标题。
func buildDisplayNames(fact accountFact, displayName string, apiKeyMode bool) []DisplayName {
	entries := make([]DisplayName, 0, 3)
	seen := make(map[string]struct{}, 3)
	push := func(kind, value string) {
		text := strings.TrimSpace(value)
		if text == "" {
			return
		}
		if _, exists := seen[text]; exists {
			return
		}
		seen[text] = struct{}{}
		entries = append(entries, DisplayName{Type: kind, Value: text})
	}

	email := strings.TrimSpace(fact.ProfileEmail)
	syntheticPhone := ""
	if match := syntheticPhonePattern.FindStringSubmatch(email); match != nil {
		syntheticPhone = match[1]
	}
	if syntheticPhone == "" && emailDisplayValuePattern.MatchString(email) {
		push("email", email)
	}
	if syntheticPhone != "" {
		push("phone", syntheticPhone)
	}
	if apiKeyMode {
		push("name", firstNonEmpty(displayName, displayDomain(fact.UIBaseURL), "API Key"))
		return entries
	}

	name := cleanOAuthDisplayName(displayName, fact.Provider)
	if name != "" {
		if emailDisplayValuePattern.MatchString(name) {
			push("email", name)
		} else {
			push("nickName", name)
		}
	}
	if nickname := cleanOAuthDisplayName(fact.ProfileName, fact.Provider); nickname != "" && nickname != name {
		push("nickName", nickname)
	}
	if len(entries) == 0 {
		fallback := firstNonEmpty(displayName, fact.ProfileName)
		if isMeaningfulFallback(fallback, fact.Provider) {
			if emailDisplayValuePattern.MatchString(fallback) {
				push("email", fallback)
			} else {
				push("nickName", fallback)
			}
		}
	}
	return entries
}

// cleanOAuthDisplayName 过滤内部编号、Provider 标签与登录方式占位名。
func cleanOAuthDisplayName(value, provider string) string {
	text := strings.TrimSpace(value)
	if text == "" || text == "Unknown" {
		return ""
	}
	if isInternalAccountDisplayName(text, provider) {
		return ""
	}
	if isMeaninglessNickname(text, provider) {
		return ""
	}
	lower := strings.ToLower(text)
	if strings.HasPrefix(lower, "api key") || strings.HasPrefix(lower, "access token") {
		return ""
	}
	return text
}

// isInternalAccountDisplayName 判定 Provider 合成的内部编号（<provider>-<数字>）与 UUID。
// 只按当前账号的 Provider 判断，不维护 Provider 白名单。
func isInternalAccountDisplayName(value, provider string) bool {
	text := strings.TrimSpace(value)
	if text == "" {
		return false
	}
	if opaqueUUIDPattern.MatchString(text) {
		return true
	}
	providerID := strings.ToLower(strings.TrimSpace(provider))
	if providerID == "" {
		return false
	}
	prefix := providerID + "-"
	if !strings.HasPrefix(strings.ToLower(text), prefix) {
		return false
	}
	suffix := text[len(prefix):]
	if suffix == "" {
		return false
	}
	for _, char := range suffix {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

// isMeaninglessNickname 判定零身份价值的展示名：Provider 自己的名字，或
// 「Provider 名 + 括号补充」（Kiro (Google)、OpenCode API (k3j9)）。
func isMeaninglessNickname(value, provider string) bool {
	text := strings.TrimSpace(value)
	if text == "" {
		return true
	}
	providerToken := normalizeProviderToken(provider)
	if providerToken == "" {
		return false
	}
	if normalizeProviderToken(text) == providerToken {
		return true
	}
	match := providerLabelSuffixPattern.FindStringSubmatch(text)
	if match == nil {
		return false
	}
	return normalizeProviderToken(match[1]) == providerToken
}

// isMeaningfulFallback 只判断值本身不是垃圾；Provider 标签类昵称允许作为最后兜底。
func isMeaningfulFallback(value, provider string) bool {
	text := strings.TrimSpace(value)
	if text == "" || text == "Unknown" {
		return false
	}
	if isInternalAccountDisplayName(text, provider) {
		return false
	}
	lower := strings.ToLower(text)
	if strings.HasPrefix(lower, "api key") || strings.HasPrefix(lower, "access token") {
		return false
	}
	return true
}

func normalizeProviderToken(value string) string {
	return providerTokenReplacer.Replace(strings.ToLower(strings.TrimSpace(value)))
}

// displayDomain 从 baseUrl 取展示域名；解析不了就退回空串。
func displayDomain(raw string) string {
	text := strings.TrimSpace(raw)
	if text == "" {
		return ""
	}
	if !strings.Contains(text, "://") {
		text = "https://" + text
	}
	parsed, err := url.Parse(text)
	if err != nil || parsed.Host == "" {
		return ""
	}
	return strings.TrimPrefix(parsed.Host, "www.")
}
