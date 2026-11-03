package claude

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

const (
	// DefaultAPIBaseURL 是静态凭据未指定上游时使用的 Anthropic 官方地址。
	DefaultAPIBaseURL = "https://api.anthropic.com"
)

var errInvalidBaseURL = fmt.Errorf("Claude Base URL 无效")

// APIKeyInput 是创建 APIKeyAuth 所需的输入。
type APIKeyInput struct {
	// APIKey 是通过 x-api-key 请求头发送的 Anthropic API 密钥。
	APIKey string
	// BaseURL 是账号绑定的 Anthropic-compatible 上游；空值使用官方地址。
	BaseURL string
}

// AuthTokenInput 是创建 AuthTokenAuth 所需的输入。
type AuthTokenInput struct {
	// AuthToken 是通过 Authorization Bearer 发送的 Claude Code Token。
	AuthToken string
	// BaseURL 是账号绑定的 Anthropic-compatible 上游；空值使用官方地址。
	BaseURL string
}

// staticCredential 保存静态认证和长效 OAuth Token 共享的凭据绑定数据。
type staticCredential struct {
	secret       *secretValue
	baseURL      string
	fingerprint  string
	identitySeed string
}

// APIKeyAuth 是构造后不可变的 x-api-key 认证值。
type APIKeyAuth struct {
	credential staticCredential
}

// AuthTokenAuth 是构造后不可变的 Authorization Bearer 认证值。
type AuthTokenAuth struct {
	credential staticCredential
}

// NewAPIKeyAuth 校验 API Key 和上游地址并构建认证值。
func NewAPIKeyAuth(input APIKeyInput) (*APIKeyAuth, error) {
	credential, err := newStaticCredential(AuthKindAPIKey, input.APIKey, input.BaseURL)
	if err != nil {
		return nil, err
	}
	return &APIKeyAuth{credential: credential}, nil
}

// NewAuthTokenAuth 校验 Bearer Token 和上游地址并构建认证值。
func NewAuthTokenAuth(input AuthTokenInput) (*AuthTokenAuth, error) {
	credential, err := newStaticCredential(AuthKindAuthToken, input.AuthToken, input.BaseURL)
	if err != nil {
		return nil, err
	}
	return &AuthTokenAuth{credential: credential}, nil
}

// newStaticCredential 统一静态凭据的指纹、端点和身份计算。
func newStaticCredential(kind AuthKind, rawSecret string, rawBaseURL string) (staticCredential, error) {
	return newCredentialBinding(fmt.Sprintf("%s:claude", kind), rawSecret, rawBaseURL)
}

// newCredentialBinding 统一凭据指纹、规范端点和本地身份计算。
func newCredentialBinding(identityNamespace string, rawSecret string, rawBaseURL string) (staticCredential, error) {
	secret, err := requireSecret(rawSecret)
	if err != nil {
		return staticCredential{}, err
	}
	baseURL, err := normalizeAPIBaseURL(rawBaseURL)
	if err != nil {
		return staticCredential{}, err
	}
	digest := sha256.Sum256([]byte(secret))
	fingerprint := hex.EncodeToString(digest[:])
	return staticCredential{
		secret:       newSecretValue(secret),
		baseURL:      baseURL,
		fingerprint:  fingerprint,
		identitySeed: fmt.Sprintf("%s:%s:%s", identityNamespace, baseURL, fingerprint),
	}, nil
}

// Kind 返回 api_key 认证类型。
func (*APIKeyAuth) Kind() AuthKind {
	return AuthKindAPIKey
}

// ProviderID 返回 Claude 认证身份绑定的规范 Provider 标识。
func (*APIKeyAuth) ProviderID() string {
	return ProviderID
}

// IdentitySeed 返回端点和 API Key 指纹组成的稳定身份种子。
func (auth *APIKeyAuth) IdentitySeed() string {
	if auth == nil {
		return ""
	}
	return auth.credential.identitySeed
}

// APIKey 返回请求适配器所需的原始 API Key。
func (auth *APIKeyAuth) APIKey() string {
	if auth == nil {
		return ""
	}
	return auth.credential.secret.reveal()
}

// BaseURL 返回规范化后的账号级上游地址。
func (auth *APIKeyAuth) BaseURL() string {
	if auth == nil {
		return ""
	}
	return auth.credential.baseURL
}

// Fingerprint 返回 API Key 的完整 SHA-256 十六进制指纹。
func (auth *APIKeyAuth) Fingerprint() string {
	if auth == nil {
		return ""
	}
	return auth.credential.fingerprint
}

// Summary 返回不包含 API Key 的认证摘要。
func (auth *APIKeyAuth) Summary() AuthSummary {
	if auth == nil {
		return AuthSummary{}
	}
	return AuthSummary{Kind: AuthKindAPIKey, BaseURL: auth.BaseURL()}
}

// String 返回不包含 API Key 的安全摘要。
func (auth *APIKeyAuth) String() string {
	if auth == nil {
		return "claude.APIKeyAuth<nil>"
	}
	return auth.Summary().String()
}

// GoString 为指针的 %#v 格式化提供安全摘要。
func (auth *APIKeyAuth) GoString() string {
	return auth.String()
}

// Format 覆盖所有合法 fmt verb，避免值格式化时反射私有字段。
func (auth APIKeyAuth) Format(state fmt.State, _ rune) {
	formatAuthSummary(state, (&auth).Summary())
}

// seal 将 APIKeyAuth 限定为 Auth 的包内实现。
func (*APIKeyAuth) seal() {}

// Kind 返回 auth_token 认证类型。
func (*AuthTokenAuth) Kind() AuthKind {
	return AuthKindAuthToken
}

// ProviderID 返回 Claude 认证身份绑定的规范 Provider 标识。
func (*AuthTokenAuth) ProviderID() string {
	return ProviderID
}

// IdentitySeed 返回端点和 Auth Token 指纹组成的稳定身份种子。
func (auth *AuthTokenAuth) IdentitySeed() string {
	if auth == nil {
		return ""
	}
	return auth.credential.identitySeed
}

// AuthToken 返回请求适配器所需的原始 Bearer Token。
func (auth *AuthTokenAuth) AuthToken() string {
	if auth == nil {
		return ""
	}
	return auth.credential.secret.reveal()
}

// BaseURL 返回规范化后的账号级上游地址。
func (auth *AuthTokenAuth) BaseURL() string {
	if auth == nil {
		return ""
	}
	return auth.credential.baseURL
}

// Fingerprint 返回 Auth Token 的完整 SHA-256 十六进制指纹。
func (auth *AuthTokenAuth) Fingerprint() string {
	if auth == nil {
		return ""
	}
	return auth.credential.fingerprint
}

// Summary 返回不包含 Auth Token 的认证摘要。
func (auth *AuthTokenAuth) Summary() AuthSummary {
	if auth == nil {
		return AuthSummary{}
	}
	return AuthSummary{Kind: AuthKindAuthToken, BaseURL: auth.BaseURL()}
}

// String 返回不包含 Auth Token 的安全摘要。
func (auth *AuthTokenAuth) String() string {
	if auth == nil {
		return "claude.AuthTokenAuth<nil>"
	}
	return auth.Summary().String()
}

// GoString 为指针的 %#v 格式化提供安全摘要。
func (auth *AuthTokenAuth) GoString() string {
	return auth.String()
}

// Format 覆盖所有合法 fmt verb，避免值格式化时反射私有字段。
func (auth AuthTokenAuth) Format(state fmt.State, _ rune) {
	formatAuthSummary(state, (&auth).Summary())
}

// seal 将 AuthTokenAuth 限定为 Auth 的包内实现。
func (*AuthTokenAuth) seal() {}

// normalizeAPIBaseURL 将同义 HTTP(S) 地址收敛为稳定身份格式。
func normalizeAPIBaseURL(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return DefaultAPIBaseURL, nil
	}
	if raw != value || hasControlCharacter(value) || strings.Contains(value, "#") {
		return "", errInvalidBaseURL
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Opaque != "" || parsed.Host == "" {
		return "", errInvalidBaseURL
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", errInvalidBaseURL
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || parsed.RawFragment != "" {
		return "", errInvalidBaseURL
	}

	hostname := strings.ToLower(parsed.Hostname())
	if hostname == "" || hasControlCharacter(hostname) || strings.Contains(hostname, "%") {
		return "", errInvalidBaseURL
	}
	port := parsed.Port()
	if strings.HasSuffix(parsed.Host, ":") {
		return "", errInvalidBaseURL
	}
	if port != "" {
		portNumber, err := strconv.Atoi(port)
		if err != nil || portNumber < 1 || portNumber > 65_535 {
			return "", errInvalidBaseURL
		}
		port = strconv.Itoa(portNumber)
	}
	if (scheme == "https" && port == "443") || (scheme == "http" && port == "80") {
		port = ""
	}
	host := hostname
	if strings.Contains(hostname, ":") {
		host = "[" + hostname + "]"
	}
	if port != "" {
		host += ":" + port
	}

	path := strings.TrimRight(parsed.EscapedPath(), "/")
	return scheme + "://" + host + path, nil
}
