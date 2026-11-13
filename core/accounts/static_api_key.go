package accounts

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
	// StaticAPIKeyAuthKind 是通用静态 API Key 凭据在数据库中的认证类别。
	StaticAPIKeyAuthKind = "api_key"
	// StaticAPIKeyAuthMode 是通用静态 API Key 凭据的持久化编码版本。
	StaticAPIKeyAuthMode = "static_api_key_v1"
)

var (
	// ErrInvalidStaticAPIKey 表示通用静态 API Key 输入无效或不支持该 Provider。
	ErrInvalidStaticAPIKey = errors.New("静态 API Key 凭据无效")
	// ErrInvalidStaticBaseURL 表示静态账号绑定的 Base URL 格式无效。
	ErrInvalidStaticBaseURL = errors.New("静态账号 Base URL 无效")
)

// StaticAPIKeyInput 是创建通用只读 StaticAPIKeyAuth 所需的输入。
//
// codex 与 claude 各自保留强类型静态凭据结构；其余在 Provider 合同中声明了
// api-key 方式的 Provider（gemini api-key、opencode、grok、kimi、zcode、
// codebuddy/workbuddy 家族、cline）共用本结构，保证与 Node 同一身份种子公式：
//
//	api_key:<provider>:<normalizedBaseUrl>:<sha256(apiKey)[:16]>
type StaticAPIKeyInput struct {
	ProviderID string
	APIKey     string
	BaseURL    string
}

// StaticAPIKeyAuth 是构造后不可变的通用静态 API Key 凭据。
type StaticAPIKeyAuth struct {
	providerID   string
	apiKey       string
	baseURL      string
	fingerprint  string
	identitySeed string
}

// NewStaticAPIKeyAuth 校验 Provider、密钥和可选端点，构建通用只读静态 API Key 凭据。
func NewStaticAPIKeyAuth(input StaticAPIKeyInput) (*StaticAPIKeyAuth, error) {
	providerID := strings.ToLower(strings.TrimSpace(input.ProviderID))
	if !isCanonicalProviderID(providerID) || providerID == "codex" || providerID == "claude" {
		return nil, ErrInvalidStaticAPIKey
	}
	apiKey, err := requireStaticSecret(input.APIKey)
	if err != nil {
		return nil, err
	}
	baseURL, err := NormalizeStaticBaseURL(input.BaseURL)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256([]byte(apiKey))
	fingerprint := hex.EncodeToString(digest[:])[:16]
	return &StaticAPIKeyAuth{
		providerID:   providerID,
		apiKey:       apiKey,
		baseURL:      baseURL,
		fingerprint:  fingerprint,
		identitySeed: fmt.Sprintf("api_key:%s:%s:%s", providerID, baseURL, fingerprint),
	}, nil
}

// ProviderID 返回绑定后的规范 Provider ID。
func (auth *StaticAPIKeyAuth) ProviderID() string {
	if auth == nil {
		return ""
	}
	return auth.providerID
}

// AuthKind 返回持久化使用的凭据类别（"api_key"）。
func (*StaticAPIKeyAuth) AuthKind() string {
	return StaticAPIKeyAuthKind
}

// IdentitySeed 返回与 Node account-identity 同公式的稳定身份种子。
func (auth *StaticAPIKeyAuth) IdentitySeed() string {
	if auth == nil {
		return ""
	}
	return auth.identitySeed
}

// APIKey 返回原始 Bearer/API 密钥。
func (auth *StaticAPIKeyAuth) APIKey() string {
	if auth == nil {
		return ""
	}
	return auth.apiKey
}

// BaseURL 返回规范化后的账号级上游地址（未配置时为空串）。
func (auth *StaticAPIKeyAuth) BaseURL() string {
	if auth == nil {
		return ""
	}
	return auth.baseURL
}

// Fingerprint 返回 API Key 的 SHA-256 前 16 位十六进制指纹。
func (auth *StaticAPIKeyAuth) Fingerprint() string {
	if auth == nil {
		return ""
	}
	return auth.fingerprint
}

// String 返回脱敏后的凭据摘要，绝不泄露原始密钥。
func (auth *StaticAPIKeyAuth) String() string {
	if auth == nil {
		return "accounts.StaticAPIKeyAuth<nil>"
	}
	return fmt.Sprintf(
		"accounts.StaticAPIKeyAuth{provider:%s baseURL:%q fingerprint:%s}",
		auth.providerID,
		auth.baseURL,
		auth.fingerprint,
	)
}

// GoString 确保 %#v 格式化也不泄露原始密钥。
func (auth *StaticAPIKeyAuth) GoString() string {
	return auth.String()
}

// Format 拦截所有 fmt 格式化动词，避免反射打印私有 apiKey 字段。
func (auth StaticAPIKeyAuth) Format(state fmt.State, _ rune) {
	_, _ = state.Write([]byte(auth.String()))
}

func requireStaticSecret(raw string) (string, error) {
	if raw == "" || raw != strings.TrimSpace(raw) {
		return "", ErrInvalidStaticAPIKey
	}
	if strings.IndexFunc(raw, isStaticControlChar) >= 0 {
		return "", ErrInvalidStaticAPIKey
	}
	return raw, nil
}

// NormalizeStaticBaseURL 将同义 HTTP(S) 上游地址收敛为稳定身份可复现的规范格式。
// 空串表示不覆盖默认地址，原样返回空串。
func NormalizeStaticBaseURL(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", nil
	}
	if strings.IndexFunc(value, isStaticControlChar) >= 0 || strings.Contains(value, "#") {
		return "", ErrInvalidStaticBaseURL
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Opaque != "" || parsed.Host == "" {
		return "", ErrInvalidStaticBaseURL
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", ErrInvalidStaticBaseURL
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || parsed.RawFragment != "" {
		return "", ErrInvalidStaticBaseURL
	}
	hostname := strings.ToLower(parsed.Hostname())
	if hostname == "" || strings.IndexFunc(hostname, isStaticControlChar) >= 0 || strings.Contains(hostname, "%") {
		return "", ErrInvalidStaticBaseURL
	}
	port := parsed.Port()
	if strings.HasSuffix(parsed.Host, ":") {
		return "", ErrInvalidStaticBaseURL
	}
	if port != "" {
		portNumber, err := strconv.Atoi(port)
		if err != nil || portNumber < 1 || portNumber > 65_535 {
			return "", ErrInvalidStaticBaseURL
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

func isStaticControlChar(character rune) bool {
	return character < 0x20 || character == 0x7f
}
