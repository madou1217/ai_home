package providers

import "strings"

// CodeBuddy 家族的身份域事实。
//
// 同一个 issuer 可能服务多个发行版：国内站 CodeBuddy CN / WorkBuddy CN 共用腾讯
// Copilot realm。这里是身份归属的唯一来源。
//
// 注意：`sessionscan/sessionread` 还有一套「issuer → 会话存储站点」的口径，
// 与身份归属不同（例如 copilot.tencent.com 在存储侧归到 codebuddy）。那套口径
// 服务于会话目录选择，不能拿这里的结果替换，见其代码注释。
var codeBuddyFamilyIssuers = []struct {
	url       string
	providers []string
}{
	{url: "https://www.codebuddy.ai/auth/realms/copilot", providers: []string{"codebuddy"}},
	{url: "https://www.workbuddy.ai/auth/realms/copilot", providers: []string{"workbuddy"}},
	{url: "https://www.workbuddy.cn/auth/realms/copilot", providers: []string{"codebuddycn", "workbuddycn"}},
	{url: "https://www.codebuddy.cn/auth/realms/copilot", providers: []string{"codebuddycn", "workbuddycn"}},
	{url: "https://copilot.tencent.com/auth/realms/copilot", providers: []string{"codebuddycn", "workbuddycn"}},
}

// ProvidersForCodeBuddyIssuer 返回 issuer 认可的发行版（副本）；未知 issuer 返回 nil。
func ProvidersForCodeBuddyIssuer(issuer string) []string {
	trimmed := strings.TrimSpace(issuer)
	for _, entry := range codeBuddyFamilyIssuers {
		if entry.url == trimmed {
			return append([]string(nil), entry.providers...)
		}
	}
	return nil
}

// IsCodeBuddyIssuerForProvider 判断 issuer 是否认可该 Provider。
func IsCodeBuddyIssuerForProvider(issuer, providerID string) bool {
	trimmed := strings.TrimSpace(providerID)
	if trimmed == "" {
		return false
	}
	for _, provider := range ProvidersForCodeBuddyIssuer(issuer) {
		if provider == trimmed {
			return true
		}
	}
	return false
}
