package claude

import "fmt"

// OAuthTokenInput 是创建长效、不可刷新 OAuth access token 所需的输入。
//
// 官方 setup-token 只输出 CLAUDE_CODE_OAUTH_TOKEN，不提供 refresh token、
// expiresAt 或 oauthAccount，因此其稳定身份只能绑定规范端点和凭据指纹。
type OAuthTokenInput struct {
	// AccessToken 是通过 Authorization Bearer 发送的 OAuth access token。
	AccessToken string
	// BaseURL 是账号绑定的 Anthropic-compatible 上游；空值使用官方地址。
	BaseURL string
}

// OAuthTokenAuth 是 setup-token 或 CLAUDE_CODE_OAUTH_TOKEN 对应的 OAuth 值对象。
type OAuthTokenAuth struct {
	credential staticCredential
}

// NewOAuthTokenAuth 校验长效 OAuth Token 和上游地址并构建只读认证值。
func NewOAuthTokenAuth(input OAuthTokenInput) (*OAuthTokenAuth, error) {
	credential, err := newCredentialBinding(
		"oauth:claude:token",
		input.AccessToken,
		input.BaseURL,
	)
	if err != nil {
		return nil, err
	}
	return &OAuthTokenAuth{credential: credential}, nil
}

// Kind 返回 oauth 账号认证类型。
func (*OAuthTokenAuth) Kind() AuthKind {
	return AuthKindOAuth
}

// ProviderID 返回 Claude 认证身份绑定的规范 Provider 标识。
func (*OAuthTokenAuth) ProviderID() string {
	return ProviderID
}

// Mode 返回不可刷新 access token 模式。
func (*OAuthTokenAuth) Mode() OAuthMode {
	return OAuthModeAccessToken
}

// IdentitySeed 返回端点和 Token 指纹组成的 AIH 凭据绑定身份。
func (auth *OAuthTokenAuth) IdentitySeed() string {
	if auth == nil {
		return ""
	}
	return auth.credential.identitySeed
}

// AccessToken 返回请求适配器所需的原始 OAuth Token。
func (auth *OAuthTokenAuth) AccessToken() string {
	if auth == nil {
		return ""
	}
	return auth.credential.secret.reveal()
}

// BaseURL 返回规范化后的账号级上游地址。
func (auth *OAuthTokenAuth) BaseURL() string {
	if auth == nil {
		return ""
	}
	return auth.credential.baseURL
}

// Fingerprint 返回 OAuth Token 的完整 SHA-256 十六进制指纹。
func (auth *OAuthTokenAuth) Fingerprint() string {
	if auth == nil {
		return ""
	}
	return auth.credential.fingerprint
}

// Scopes 返回官方 setup-token 固定的 inference-only 权限集合。
func (auth *OAuthTokenAuth) Scopes() []string {
	if auth == nil {
		return nil
	}
	return []string{InferenceScope}
}

// HasScope 判断长效 OAuth Token 是否拥有指定权限。
func (auth *OAuthTokenAuth) HasScope(scope string) bool {
	return auth != nil && scope == InferenceScope
}

// Summary 返回不包含 OAuth Token 的认证摘要。
func (auth *OAuthTokenAuth) Summary() AuthSummary {
	if auth == nil {
		return AuthSummary{}
	}
	return AuthSummary{
		Kind:      AuthKindOAuth,
		OAuthMode: OAuthModeAccessToken,
		BaseURL:   auth.BaseURL(),
	}
}

// String 返回不包含 OAuth Token 的安全摘要。
func (auth *OAuthTokenAuth) String() string {
	if auth == nil {
		return "claude.OAuthTokenAuth<nil>"
	}
	return auth.Summary().String()
}

// GoString 为指针的 %#v 格式化提供安全摘要。
func (auth *OAuthTokenAuth) GoString() string {
	return auth.String()
}

// Format 覆盖所有合法 fmt verb，避免值格式化时反射私有字段。
func (auth OAuthTokenAuth) Format(state fmt.State, _ rune) {
	formatAuthSummary(state, (&auth).Summary())
}

// seal 将 OAuthTokenAuth 限定为 Auth 的包内实现。
func (*OAuthTokenAuth) seal() {}
