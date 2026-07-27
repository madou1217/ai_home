// Package claude 定义 Claude 账号认证的纯领域模型。
//
// 该包只表达 OAuth、API Key 与 Auth Token 的稳定身份和凭据不变量，
// 不依赖数据库、Claude secure storage、Keychain、Server 或网络刷新逻辑。
package claude

import "fmt"

// AuthKind 表示 Claude 纯账号唯一允许的认证类型。
type AuthKind string

const (
	// AuthKindOAuth 表示 Claude.ai OAuth 账号。
	AuthKindOAuth AuthKind = "oauth"
	// AuthKindAPIKey 表示使用 x-api-key 的 Anthropic API 账号。
	AuthKindAPIKey AuthKind = "api_key"
	// AuthKindAuthToken 表示使用 Authorization Bearer 的 Claude Code Token 账号。
	AuthKindAuthToken AuthKind = "auth_token"
)

// OAuthMode 区分同一 OAuth 账号类型下的两种官方凭据生命周期。
type OAuthMode string

const (
	// OAuthModeRefreshable 表示 auth login 产生的可刷新 secure storage 凭据。
	OAuthModeRefreshable OAuthMode = "refreshable"
	// OAuthModeAccessToken 表示 setup-token 或 CLAUDE_CODE_OAUTH_TOKEN 提供的长效 access token。
	OAuthModeAccessToken OAuthMode = "access_token"
)

// String 返回稳定且不包含凭据的认证类型文本。
func (kind AuthKind) String() string {
	switch kind {
	case AuthKindOAuth, AuthKindAPIKey, AuthKindAuthToken:
		return string(kind)
	default:
		return "unknown"
	}
}

// String 返回稳定的 OAuth 凭据模式文本。
func (mode OAuthMode) String() string {
	switch mode {
	case OAuthModeRefreshable, OAuthModeAccessToken:
		return string(mode)
	default:
		return "unknown"
	}
}

// Auth 是 Claude 认证的封闭领域接口。
//
// 未导出的 seal 方法确保调用方只能使用经过本包构造器校验的认证变体。
type Auth interface {
	fmt.Stringer
	Kind() AuthKind
	IdentitySeed() string
	Summary() AuthSummary
	GoString() string
	seal()
}

// AuthSummary 是不包含 Token 或 API Key 的认证摘要。
type AuthSummary struct {
	// Kind 是认证类型。
	Kind AuthKind
	// OAuthMode 是 OAuth 凭据生命周期；非 OAuth 类型为空。
	OAuthMode OAuthMode
	// AccountUUID 是 OAuth 的稳定 Claude 账号 UUID。
	AccountUUID string
	// Email 是 OAuth 登录得到的公开邮箱。
	Email string
	// OrganizationUUID 是 OAuth 当前组织 UUID；空值表示未知。
	OrganizationUUID string
	// SubscriptionType 是 Claude.ai 套餐类型；空值表示官方未返回。
	SubscriptionType string
	// RateLimitTier 是 Claude.ai 额度层级；空值表示官方未返回。
	RateLimitTier string
	// ExpiresAtMS 是 OAuth Access Token 的绝对过期时间。
	ExpiresAtMS int64
	// BaseURL 是静态凭据绑定的规范化上游地址。
	BaseURL string
}

// String 返回适合日志展示的脱敏摘要。
func (summary AuthSummary) String() string {
	switch summary.Kind {
	case AuthKindOAuth:
		if summary.OAuthMode == OAuthModeAccessToken {
			return fmt.Sprintf(
				"claude.AuthSummary{kind=%s,oauth_mode=%s,base_url=%s}",
				summary.Kind,
				summary.OAuthMode,
				summary.BaseURL,
			)
		}
		return fmt.Sprintf(
			"claude.AuthSummary{kind=%s,oauth_mode=%s,account_uuid=%s,email=%s,organization_uuid=%s,subscription=%s,rate_limit_tier=%s,expires_at_ms=%d}",
			summary.Kind,
			summary.OAuthMode,
			summary.AccountUUID,
			summary.Email,
			summary.OrganizationUUID,
			summary.SubscriptionType,
			summary.RateLimitTier,
			summary.ExpiresAtMS,
		)
	case AuthKindAPIKey, AuthKindAuthToken:
		return fmt.Sprintf("claude.AuthSummary{kind=%s,base_url=%s}", summary.Kind, summary.BaseURL)
	default:
		return "claude.AuthSummary{kind=unknown}"
	}
}

// GoString 确保 %#v 也使用脱敏摘要。
func (summary AuthSummary) GoString() string {
	return summary.String()
}

// secretValue 包装进程内明文凭据，阻止 fmt 反射路径输出原始值。
type secretValue string

// newSecretValue 使用私有指针保存凭据，使异常格式化路径最多只能看到地址。
func newSecretValue(raw string) *secretValue {
	value := secretValue(raw)
	return &value
}

// reveal 仅供显式凭据访问器返回原始值。
func (value *secretValue) reveal() string {
	if value == nil {
		return ""
	}
	return string(*value)
}

// String 对普通格式化返回固定脱敏文本。
func (secretValue) String() string {
	return "<redacted>"
}

// GoString 对 %#v 格式化返回固定脱敏文本。
func (secretValue) GoString() string {
	return "<redacted>"
}

// formatAuthSummary 忽略调用方 verb，把所有 fmt 路径统一为安全摘要。
func formatAuthSummary(state fmt.State, summary AuthSummary) {
	_, _ = state.Write([]byte(summary.String()))
}
