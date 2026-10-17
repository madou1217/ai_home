// Package grokrelay 实现 Grok (xAI) 的 OpenAI Chat Completions 原生透传通道。
//
// 与 clinerelay 同属「多数派零覆盖」：上游就是标准 OpenAI 兼容端点
// （POST https://api.x.ai/v1/chat/completions + Bearer <key>），没有任何硬约束。
// 与 cline 的唯一差别是端点与凭据取法（grok 支持 API Key 与 OAuth 两种登录态）。
//
// 上游契约（与 Node 侧 lib/account/provider-api-base-url.js 同源）：
//
//	POST https://api.x.ai/v1/chat/completions
//	  Authorization: Bearer <XAI_API_KEY 或 OAuth access token>
//	  Content-Type: application/json
//
// 账号级 XAI_BASE_URL 可覆盖（自建/企业代理）。
package grokrelay

import (
	"encoding/json"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

// ProviderID 是本通道服务的 Provider。
const ProviderID = "grok"

// DefaultBaseURL 是 xAI 的官方 API 端点。
const DefaultBaseURL = "https://api.x.ai/v1"

// ChatCompletionsPath 是上游的 chat completions 路径（标准 OpenAI 形态）。
const ChatCompletionsPath = "/chat/completions"

// Provider 是 grok 在 relaycore 上的实现 —— **零覆盖**。
//
// 它只提供端点与凭据取法；改写、请求头、错误分类全部沿用 BaseProvider 默认行为。
type Provider struct {
	relaycore.BaseProvider
}

var _ relaycore.Provider = Provider{}

// NewProvider 构造 grok 透传 Provider。
//
// accountBaseURL 为空时用 DefaultBaseURL（对应 Node 的账号级 XAI_BASE_URL 覆盖）。
func NewProvider(accountBaseURL string) Provider {
	base := strings.TrimRight(strings.TrimSpace(accountBaseURL), "/")
	if base == "" {
		base = DefaultBaseURL
	}
	return Provider{
		BaseProvider: relaycore.NewBaseProvider(ProviderID, base+ChatCompletionsPath),
	}
}

// AccessTokenFromCredential 从 grok 凭据里取鉴权令牌。
//
// grok 有两种登录态，取法不同：
//   - API Key 账号：凭据载荷里的 api_key / apiKey；
//   - OAuth 账号：原生凭据载荷里的 access_token（xAI 的 OAuth 令牌）。
//
// 两种都取不到就是确定性不适配，交还 Canonical（不猜字段）。
func AccessTokenFromCredential(credential accountapp.Credential) (string, error) {
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil {
		return "", relaycore.ErrUnsupportedCredential
	}
	token, found := accessTokenFromPayload(native.Payload())
	if !found {
		return "", relaycore.ErrUnsupportedCredential
	}
	return token, nil
}

// AccessToken 实现 relaycore.Provider。
func (provider Provider) AccessToken(credential accountapp.Credential) (string, error) {
	return AccessTokenFromCredential(credential)
}

// accessTokenFromPayload 从 grok 原生凭据载荷里取 access token（纯函数，便于独立测试）。
//
// 兼容两种形态：扁平 API Key（{api_key}）与 OAuth 原生文档
// （{auth: {default: {access_token}}} 或 {credentials: {...}}）。
func accessTokenFromPayload(payload []byte) (string, bool) {
	fields, ok := relaycore.DecodeRawObject(payload)
	if !ok {
		return "", false
	}
	// 形态一：扁平 API Key。
	for _, key := range []string{"api_key", "apiKey", "access_token", "accessToken"} {
		if token, ok := relaycore.RawString(fields[key]); ok && strings.TrimSpace(token) != "" {
			return strings.TrimSpace(token), true
		}
	}
	// 形态二：OAuth 原生文档（auth.<issuer>::<uuid>.key —— grok CLI 的登录态形状）。
	//
	// 这是 grok 的实际形态（实测 2026-10-17）：凭据文档顶层是 `auth`，其下每个键是
	// `<issuer>::<uuid>`，值里带 `key`（JWT access token）与 `refresh_token` 等。
	// 键名不是固定字面量，因此要**遍历**而不是按名取。
	if auth, ok := relaycore.DecodeRawObject(fields["auth"]); ok {
		if token, found := scanAuthRecords(auth); found {
			return token, true
		}
	}
	// 形态三：credentials（其它 provider 的同名容器）。
	if credentials, ok := relaycore.DecodeRawObject(fields["credentials"]); ok {
		if token, found := scanAuthRecords(credentials); found {
			return token, true
		}
	}
	return "", false
}

// scanAuthRecords 在一层记录里找鉴权令牌。
//
// 两种形状都要认：直接带字段的记录（`{access_token}`），以及 `{<name>: {key}}`
// 这种嵌套（grok 的 `auth.<issuer>::<uuid>.key`）。
func scanAuthRecords(record map[string]json.RawMessage) (string, bool) {
	// 直接字段优先（含 grok 的 `key`）。
	for _, key := range []string{"access_token", "accessToken", "api_key", "apiKey", "key"} {
		if token, ok := relaycore.RawString(record[key]); ok && strings.TrimSpace(token) != "" {
			return strings.TrimSpace(token), true
		}
	}
	// 再下探一层：auth 下可能还有 default，或每个键各是一条记录。
	if inner, ok := relaycore.DecodeRawObject(record["default"]); ok {
		for _, key := range []string{"access_token", "accessToken", "api_key", "apiKey", "key"} {
			if token, ok := relaycore.RawString(inner[key]); ok && strings.TrimSpace(token) != "" {
				return strings.TrimSpace(token), true
			}
		}
	}
	for name, raw := range record {
		if name == "default" {
			continue
		}
		nested, ok := relaycore.DecodeRawObject(raw)
		if !ok {
			continue
		}
		for _, key := range []string{"key", "access_token", "accessToken"} {
			if token, ok := relaycore.RawString(nested[key]); ok && strings.TrimSpace(token) != "" {
				return strings.TrimSpace(token), true
			}
		}
	}
	return "", false
}

// SupportsHTTPModelDiscovery 判定该凭据形态能否走 HTTP 模型发现。
//
// grok 的 `GET /models` **只认 API Key**：OAuth 登录态会被上游 403（2026-10-17 实测
// 两个 OAuth 账号都是 403）。这与 Node 侧一致——那边的 grok 目录对 OAuth 账号走本地
// CLI（`grok models`），HTTP 探测只服务 API Key 账号。
//
// 因此 OAuth 账号在 Go 侧（服务端无本机 CLI）**没有模型目录**，这是能力边界而非缺陷：
// 明确拒绝让刷新保持旧目录，而不是反复发一个必被 403 的请求。
func SupportsHTTPModelDiscovery(credential accountapp.Credential) bool {
	if credential == nil || credential.ProviderID() != ProviderID {
		return false
	}
	payload := credentialPayload(credential)
	if len(payload) == 0 {
		return false
	}
	fields, ok := relaycore.DecodeRawObject(payload)
	if !ok {
		return false
	}
	// API Key 形态：扁平 api_key / apiKey。OAuth 形态的顶层是 auth 记录。
	for _, key := range []string{"api_key", "apiKey"} {
		if token, ok := relaycore.RawString(fields[key]); ok && strings.TrimSpace(token) != "" {
			return true
		}
	}
	return false
}

// credentialPayload 取凭据文档原始字节（非原生凭据返回 nil）。
func credentialPayload(credential accountapp.Credential) []byte {
	native, ok := credential.(interface{ Payload() []byte })
	if !ok || native == nil {
		return nil
	}
	return native.Payload()
}
