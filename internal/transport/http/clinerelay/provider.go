// Package clinerelay 实现 Cline 的 OpenAI Chat Completions 原生透传通道。
//
// 这是 relaycore 抽象层验证「多数派零覆盖」的第一个真实用例：cline 的上游就是标准
// OpenAI 兼容端点，**没有任何硬约束**，因此本包只声明端点与凭据取法，改写、请求头、
// 错误分类全部沿用 relaycore.BaseProvider 的默认实现。
//
// 对照：家族（codebuddy / workbuddy 四支）覆盖了六处差异（路径抬升、真实 UA、
// Origin/Referer、stream 恒 true、首条补 system、tool_choice 翻译、腾讯信封），
// 那些差异全部集中在 codebuddyfamilyrelay/provider.go 一个文件里。
//
// 上游契约（2026-10-17 实测与 Node 侧 lib/account/provider-api-base-url.js 同源）：
//
//	POST https://api.cline.bot/api/v1/chat/completions
//	  Authorization: Bearer workos:<JWT>     ← 前缀是 wire 格式的一部分，不能剥
//	  Content-Type: application/json
//
// 账号级 CLINE_API_BASE_URL 可覆盖（自建/企业代理）。
package clinerelay

import (
	"encoding/json"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

// ProviderID 是本通道服务的 Provider。
const ProviderID = "cline"

// DefaultBaseURL 是 Cline REST 面（Cline Pass 订阅与 API Key 共用同一端点）。
const DefaultBaseURL = "https://api.cline.bot/api/v1"

// ChatCompletionsPath 是上游的 chat completions 路径（标准 OpenAI 形态，无需抬升）。
const ChatCompletionsPath = "/chat/completions"

// AccessTokenFromCredential 从 cline 原生凭据里取鉴权令牌（供传输策略与通道共用）。
//
// 与家族一样，凭据形态由账号领域决定，relaycore 不该猜（BaseProvider 的默认实现
// 一律拒绝）。cline 的令牌在 `providers.<slot>.settings.auth.accessToken`，
// 且**带 `workos:` 前缀**——裸 JWT 上游会 401（Node 侧 2026-10-14 实测）。
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

// Provider 是 cline 在 relaycore 上的实现 —— **零覆盖**。
//
// 它只提供两件事：端点与凭据取法。其余全部沿用 BaseProvider 的默认行为，
// 这正是抽象层要达到的效果（多数派 Provider 不必写任何差异代码）。
type Provider struct {
	relaycore.BaseProvider
	// baseURL 是账号级或默认的站点根。
	baseURL string
}

// 编译期确认实现满足 relaycore 契约。
var _ relaycore.Provider = Provider{}

// NewProvider 构造 cline 透传 Provider。
//
// accountBaseURL 为空时用 DefaultBaseURL（对应 Node 的账号级 CLINE_API_BASE_URL 覆盖）。
func NewProvider(accountBaseURL string) Provider {
	base := strings.TrimRight(strings.TrimSpace(accountBaseURL), "/")
	if base == "" {
		base = DefaultBaseURL
	}
	return Provider{
		BaseProvider: relaycore.NewBaseProvider(ProviderID, base+ChatCompletionsPath),
		baseURL:      base,
	}
}

// AccessToken 实现 relaycore.Provider：委托给包级函数（传输策略也用它）。
func (provider Provider) AccessToken(credential accountapp.Credential) (string, error) {
	return AccessTokenFromCredential(credential)
}

// accessTokenFromPayload 从 cline 原生凭据载荷里取 access token（纯函数，便于独立测试）。
//
// 只认 cline 自己的槽位（cline / cline-pass）：同一份文档里还装着**别的 provider 的
// 明文密钥**，读错槽位会造成跨账号串号。
func accessTokenFromPayload(payload []byte) (string, bool) {
	fields, ok := relaycore.DecodeRawObject(payload)
	if !ok {
		return "", false
	}
	// 文档形态：{auth: {providers: {<slot>: {settings: {auth: {accessToken}}}}}}
	root := fields
	if auth, ok := relaycore.DecodeRawObject(fields["auth"]); ok {
		root = auth
	}
	providers, ok := relaycore.DecodeRawObject(root["providers"])
	if !ok {
		// 也接受「已收窄到单槽位」的形态：{settings: {auth: {...}}}。
		return accessTokenFromSlot(root)
	}
	for _, slotID := range []string{"cline", "cline-pass"} {
		slot, ok := relaycore.DecodeRawObject(providers[slotID])
		if !ok {
			continue
		}
		if token, found := accessTokenFromSlot(slot); found {
			return token, true
		}
	}
	return "", false
}

// accessTokenFromSlot 从单个槽位里取 accessToken。
func accessTokenFromSlot(slot map[string]json.RawMessage) (string, bool) {
	settings, ok := relaycore.DecodeRawObject(slot["settings"])
	if !ok {
		settings = slot
	}
	auth, ok := relaycore.DecodeRawObject(settings["auth"])
	if !ok {
		return "", false
	}
	for _, key := range []string{"accessToken", "access_token"} {
		if token, ok := relaycore.RawString(auth[key]); ok && strings.TrimSpace(token) != "" {
			return strings.TrimSpace(token), true
		}
	}
	return "", false
}
