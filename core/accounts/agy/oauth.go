package agy

import (
	"errors"
	"fmt"
	"net/mail"
	"strings"
)

const maxUnixMillis int64 = 253_402_300_799_999

var errInvalidOAuth = errors.New("AGY OAuth 凭据无效")

// OAuthInput 是从原生 Antigravity oauthToken 文档构造领域凭据的完整字段。
type OAuthInput struct {
	Email         string
	AccessToken   string
	RefreshToken  string
	ExpiresAtMS   int64
	RefreshedAtMS int64
	TokenType     string
	AuthMethod    AuthMethod
}

// OAuthAuth 是构造后不可变的 Antigravity consumer OAuth 凭据。
//
// 稳定身份只来自规范 email；Access/Refresh Token 轮换不得改变 AccountRef。
type OAuthAuth struct {
	email         string
	accessToken   string
	refreshToken  string
	expiresAtMS   int64
	refreshedAtMS int64
	tokenType     string
	authMethod    AuthMethod
	identitySeed  string
}

// NewOAuthAuth 校验原生凭据并建立不会从轮换 secret 派生的稳定身份。
func NewOAuthAuth(input OAuthInput) (*OAuthAuth, error) {
	email, err := normalizeEmail(input.Email)
	if err != nil ||
		!validSecret(input.AccessToken) ||
		!validSecret(input.RefreshToken) ||
		input.ExpiresAtMS <= 0 ||
		input.ExpiresAtMS > maxUnixMillis ||
		input.RefreshedAtMS <= 0 ||
		input.RefreshedAtMS >= input.ExpiresAtMS ||
		!validMetadata(input.TokenType, 32) ||
		input.AuthMethod != AuthMethodConsumer {
		return nil, errInvalidOAuth
	}
	return &OAuthAuth{
		email:         email,
		accessToken:   input.AccessToken,
		refreshToken:  input.RefreshToken,
		expiresAtMS:   input.ExpiresAtMS,
		refreshedAtMS: input.RefreshedAtMS,
		tokenType:     input.TokenType,
		authMethod:    input.AuthMethod,
		identitySeed:  "oauth:" + ProviderID + ":" + email,
	}, nil
}

// ProviderID 返回规范 Provider 身份。
func (*OAuthAuth) ProviderID() string { return ProviderID }

// Kind 返回 OAuth 认证类型。
func (*OAuthAuth) Kind() AuthKind { return AuthKindOAuth }

// IdentitySeed 返回只依赖规范 email 的稳定账号身份。
func (auth *OAuthAuth) IdentitySeed() string {
	if auth == nil {
		return ""
	}
	return auth.identitySeed
}

// Email 返回稳定公开邮箱。
func (auth *OAuthAuth) Email() string {
	if auth == nil {
		return ""
	}
	return auth.email
}

// AccessToken 返回当前上游 Bearer Token；调用方不得记录该值。
func (auth *OAuthAuth) AccessToken() string {
	if auth == nil {
		return ""
	}
	return auth.accessToken
}

// RefreshToken 返回官方刷新协议使用的长期凭据；调用方不得记录该值。
func (auth *OAuthAuth) RefreshToken() string {
	if auth == nil {
		return ""
	}
	return auth.refreshToken
}

// ExpiresAtMS 返回 Access Token 绝对过期时间。
func (auth *OAuthAuth) ExpiresAtMS() int64 {
	if auth == nil {
		return 0
	}
	return auth.expiresAtMS
}

// RefreshedAtMS 返回最近一次取得 Token 的时间。
func (auth *OAuthAuth) RefreshedAtMS() int64 {
	if auth == nil {
		return 0
	}
	return auth.refreshedAtMS
}

// TokenType 返回 OAuth token_type。
func (auth *OAuthAuth) TokenType() string {
	if auth == nil {
		return ""
	}
	return auth.tokenType
}

// AuthMethod 返回原生 Antigravity CLI 认证模式。
func (auth *OAuthAuth) AuthMethod() AuthMethod {
	if auth == nil {
		return ""
	}
	return auth.authMethod
}

// String 返回只包含公开身份的安全摘要。
func (auth *OAuthAuth) String() string {
	if auth == nil {
		return "agy.OAuthAuth<nil>"
	}
	return fmt.Sprintf("agy.OAuthAuth{email:%q}", auth.email)
}

// GoString 阻止 %#v 展开未导出的 Token 字段。
func (auth *OAuthAuth) GoString() string { return auth.String() }

func normalizeEmail(value string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	parsed, err := mail.ParseAddress(normalized)
	if err != nil || parsed.Address != normalized ||
		strings.Count(normalized, "@") != 1 || len(normalized) > 320 {
		return "", errInvalidOAuth
	}
	return normalized, nil
}

func validSecret(value string) bool {
	return validMetadata(value, 256*1024)
}

func validMetadata(value string, maxLength int) bool {
	return value != "" && len(value) <= maxLength &&
		value == strings.TrimSpace(value) &&
		strings.IndexFunc(value, func(character rune) bool {
			return character < 0x20 || character == 0x7f
		}) < 0
}
