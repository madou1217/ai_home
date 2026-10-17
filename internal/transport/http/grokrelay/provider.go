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
	// 形态二：OAuth 原生文档（auth.default / credentials）。
	for _, container := range []string{"auth", "credentials"} {
		nested, ok := relaycore.DecodeRawObject(fields[container])
		if !ok {
			continue
		}
		// auth 下可能还有一层 default（与 opencode 的 auth.<name> 同形）。
		if inner, ok := relaycore.DecodeRawObject(nested["default"]); ok {
			nested = inner
		}
		for _, key := range []string{"access_token", "accessToken", "api_key", "apiKey"} {
			if token, ok := relaycore.RawString(nested[key]); ok && strings.TrimSpace(token) != "" {
				return strings.TrimSpace(token), true
			}
		}
	}
	return "", false
}
