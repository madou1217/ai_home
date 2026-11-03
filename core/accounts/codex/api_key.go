package codex

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

const (
	// DefaultAPIBaseURL 是 Codex API Key 账号未指定端点时使用的官方地址。
	DefaultAPIBaseURL = "https://api.openai.com/v1"
)

var (
	errInvalidAPIKey  = errors.New("Codex API Key 无效")
	errInvalidBaseURL = errors.New("Codex API Key Base URL 无效")
)

// APIKeyInput 是创建 APIKeyAuth 所需的完整输入。
type APIKeyInput struct {
	// APIKey 是 OpenAI 或 OpenAI-compatible 上游使用的非空 Bearer 密钥，不能包含首尾空白或控制字符。
	APIKey string
	// BaseURL 是账号绑定的上游地址；空值使用 DefaultAPIBaseURL。
	BaseURL string
}

// APIKeyAuth 是构造后不可变的 Codex API Key 认证值。
type APIKeyAuth struct {
	apiKey       *secretValue
	baseURL      string
	fingerprint  string
	identitySeed string
}

// NewAPIKeyAuth 校验密钥和端点并构建只读 API Key 认证值。
func NewAPIKeyAuth(input APIKeyInput) (*APIKeyAuth, error) {
	apiKey, err := requireSecret(input.APIKey, errInvalidAPIKey)
	if err != nil {
		return nil, err
	}
	baseURL, err := normalizeAPIBaseURL(input.BaseURL)
	if err != nil {
		return nil, err
	}

	digest := sha256.Sum256([]byte(apiKey))
	fingerprint := hex.EncodeToString(digest[:])
	return &APIKeyAuth{
		apiKey:       newSecretValue(apiKey),
		baseURL:      baseURL,
		fingerprint:  fingerprint,
		identitySeed: fmt.Sprintf("api_key:codex:%s:%s", baseURL, fingerprint),
	}, nil
}

// Kind 返回 api_key 认证类型。
func (*APIKeyAuth) Kind() AuthKind {
	return AuthKindAPIKey
}

// ProviderID 返回 Codex 认证身份绑定的规范 Provider 标识。
func (*APIKeyAuth) ProviderID() string {
	return ProviderID
}

// IdentitySeed 返回由规范端点和密钥指纹组成的稳定账号身份种子。
func (auth *APIKeyAuth) IdentitySeed() string {
	if auth == nil {
		return ""
	}
	return auth.identitySeed
}

// APIKey 返回请求适配器所需的原始密钥。
func (auth *APIKeyAuth) APIKey() string {
	if auth == nil {
		return ""
	}
	return auth.apiKey.reveal()
}

// BaseURL 返回规范化后的账号级上游地址。
func (auth *APIKeyAuth) BaseURL() string {
	if auth == nil {
		return ""
	}
	return auth.baseURL
}

// Fingerprint 返回原始密钥的完整 SHA-256 十六进制指纹。
func (auth *APIKeyAuth) Fingerprint() string {
	if auth == nil {
		return ""
	}
	return auth.fingerprint
}

// Summary 返回不包含原始 API Key 的认证摘要。
func (auth *APIKeyAuth) Summary() AuthSummary {
	if auth == nil {
		return AuthSummary{}
	}
	return AuthSummary{
		Kind:    AuthKindAPIKey,
		BaseURL: auth.baseURL,
	}
}

// String 返回不包含原始 API Key 的安全摘要。
func (auth *APIKeyAuth) String() string {
	if auth == nil {
		return "codex.APIKeyAuth<nil>"
	}
	return auth.Summary().String()
}

// GoString 为指针的 %#v 格式化提供安全摘要，值格式化由 Format 统一处理。
func (auth *APIKeyAuth) GoString() string {
	return auth.String()
}

// Format 覆盖所有合法 fmt verb，避免非字符串 verb 触发字段反射。
func (auth APIKeyAuth) Format(state fmt.State, _ rune) {
	formatAuthSummary(state, (&auth).Summary())
}

// seal 将 APIKeyAuth 限定为 Auth 的包内实现。
func (*APIKeyAuth) seal() {}

// normalizeAPIBaseURL 将同义 HTTP(S) 地址收敛为稳定身份可使用的格式。
func normalizeAPIBaseURL(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return DefaultAPIBaseURL, nil
	}
	if hasControlCharacter(value) {
		return "", errInvalidBaseURL
	}
	if strings.Contains(value, "#") {
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
	// IPv6 zone 依赖本机接口名，手工规范化既不稳定也无法形成跨主机账号身份。
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
