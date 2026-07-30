// Package transportpolicy 集中定义 Claude 凭据与传输方式的稳定兼容规则。
package transportpolicy

import (
	"net/url"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
)

const officialAPIHostname = "api.anthropic.com"

// RequiresNativeOAuth 判断凭据是否必须保留官方 Claude Runtime 请求证明。
//
// 可刷新 OAuth 始终属于官方订阅账号；setup-token 只有指向官方端点时才受此约束。
func RequiresNativeOAuth(credential accountapp.Credential) bool {
	switch auth := credential.(type) {
	case *claudeauth.OAuthAuth:
		return auth != nil
	case *claudeauth.OAuthTokenAuth:
		return auth != nil && IsOfficialAPIBaseURL(auth.BaseURL())
	default:
		return false
	}
}

// IsOfficialAPIBaseURL 判断规范 HTTP 地址是否指向 Anthropic 官方 API。
func IsOfficialAPIBaseURL(baseURL string) bool {
	parsed, err := url.Parse(baseURL)
	return err == nil &&
		strings.EqualFold(parsed.Hostname(), officialAPIHostname)
}
