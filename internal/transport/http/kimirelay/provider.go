// Package kimirelay 实现 kimi 的 OpenAI Chat Completions 原生透传通道。
//
// 与 cline / grok 的差别：kimi 有**两处真实差异**（其余仍沿用 relaycore 默认）：
//
//  1. 设备指纹头：六个 `X-Msh-*` 头，其中 device id / name / model / os 由账号的
//     设备策略解析（见 core/accounts/kimiidentity）。缺这些头时上游按「非官方客户端」
//     对待，因此不是可选项。
//  2. 请求体字段翻译：kimi 的原生 chat 契约用 `thinking.effort` 与
//     `max_completion_tokens`，而客户端（OpenAI 协议）发的是 `reasoning_effort` 与
//     `max_tokens`。**原生字段优先**：已带 thinking / max_completion_tokens 的请求不动。
//
// 上游契约（与 Node 侧 lib/server/kimi-request-headers.js + kimi-chat-request.js 同源）：
//
//	POST {base}/chat/completions
//	  Authorization: Bearer <access token>
//	  X-Msh-Platform / X-Msh-Version / X-Msh-Device-* 等
//
// 端点按凭据类型分流（OAuth 走 coding 端点，API Key 走公开 API 主机）——见 BaseURL。
package kimirelay

import (
	"encoding/json"
	"net/http"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/kimiidentity"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

// ProviderID 是本通道服务的 Provider。
const ProviderID = "kimi"

// 上游端点：OAuth 登录态走 coding 端点，API Key 走公开 API 主机。
//
// 与 Node 侧 lib/account/kimi-endpoints.js 同源（那里也按 apiKeyMode 分流）。
const (
	KimiCodeBaseURL = "https://api.kimi.com/coding/v1"
	KimiAPIBaseURL  = "https://api.moonshot.cn/v1"
)

// ChatCompletionsPath 是上游的 chat completions 路径（标准 OpenAI 形态）。
const ChatCompletionsPath = "/chat/completions"

// 设备头常量（与 Node 侧同值）。
const (
	kimiCodePlatform    = "kimi_code_cli"
	kimiUserAgentPrefix = "kimi-code-cli"
)

// Provider 是 kimi 在 relaycore 上的实现。
//
// 覆盖三处（RewriteRequest / DecorateUpstream / AccessToken），其余沿用 BaseProvider：
// 对照 cline 的零覆盖，这正是「形态一致但不全一致」在抽象层里的表达。
type Provider struct {
	relaycore.BaseProvider
	// version 是自报的客户端版本（由调用方注入：本地 CLI 实测 → 远端 npm 最新 → 兜底）。
	version string
	// accountRef 与 profile 用于解析设备指纹（每次尝试按账号解析）。
	accountRef string
	profile    kimiidentity.Profile
	// host 是 host-derived 策略需要的运行机器信息。
	host kimiidentity.HostFacts
	// credentialDeviceID 是凭据里声明的 device_id（官方签发，优先于策略）。
	credentialDeviceID string
	// isAPIKey 决定端点分流。
	isAPIKey bool
}

var _ relaycore.Provider = Provider{}

// ProviderOptions 是构造 kimi Provider 的可注入项。
type ProviderOptions struct {
	// Version 是自报的客户端版本；为空时用 FallbackVersion。
	Version string
	// AccountRef 是本次请求服务的账号（设备指纹的派生输入）。
	AccountRef string
	// Profile 是账号的设备策略。
	Profile kimiidentity.Profile
	// Host 是 host-derived 策略需要的机器信息。
	Host kimiidentity.HostFacts
	// CredentialDeviceID 是凭据里声明的 device_id。
	CredentialDeviceID string
	// IsAPIKey 表示账号是 API Key 形态（决定端点分流）。
	IsAPIKey bool
}

// FallbackVersion 是版本解析全失败时的兜底值（与 Node 侧常量一致）。
const FallbackVersion = "0.36.0"

// NewProvider 构造 kimi 透传 Provider。
func NewProvider(options ProviderOptions) Provider {
	version := strings.TrimSpace(options.Version)
	if version == "" {
		version = FallbackVersion
	}
	base := KimiAPIBaseURL
	if !options.IsAPIKey {
		base = KimiCodeBaseURL
	}
	return Provider{
		BaseProvider:       relaycore.NewBaseProvider(ProviderID, base+ChatCompletionsPath),
		version:            version,
		accountRef:         strings.TrimSpace(options.AccountRef),
		profile:            options.Profile,
		host:               options.Host,
		credentialDeviceID: strings.TrimSpace(options.CredentialDeviceID),
		isAPIKey:           options.IsAPIKey,
	}
}

// Resolve 按账号所属 Provider 返回变体。
//
// kimi 只有一支，但**账号级参数**（设备策略、凭据形态、账号引用）不同，因此这里按
// 传入的 providerID 判定是否认领，返回的仍是同一个 Provider（参数已在构造时绑定）。
func (provider Provider) Resolve(input relaycore.ResolveInput) (relaycore.Provider, bool) {
	if !strings.EqualFold(strings.TrimSpace(input.ProviderID), ProviderID) {
		return nil, false
	}
	// 账号级参数按传入的 accountRef 重新解析：设备指纹以账号引用为派生输入，
	// 因此同一个通道对不同账号要产出不同指纹。
	resolved := provider
	if ref := strings.TrimSpace(input.AccountRef); ref != "" {
		resolved.accountRef = ref
	}
	return resolved, true
}

// AccessTokenFromCredential 从 kimi 凭据里取 access token。
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

// accessTokenFromPayload 从 kimi 原生凭据载荷里取 access token（纯函数，便于独立测试）。
//
// kimi 的 OAuth 凭据在 `credentials.access_token`（或 `auth.*` 的等价键）。
func accessTokenFromPayload(payload []byte) (string, bool) {
	fields, ok := relaycore.DecodeRawObject(payload)
	if !ok {
		return "", false
	}
	for _, container := range []string{"credentials", "auth"} {
		nested, ok := relaycore.DecodeRawObject(fields[container])
		if !ok {
			continue
		}
		for _, key := range []string{"access_token", "accessToken"} {
			if token, ok := relaycore.RawString(nested[key]); ok && strings.TrimSpace(token) != "" {
				return strings.TrimSpace(token), true
			}
		}
	}
	// 也接受扁平形态。
	for _, key := range []string{"access_token", "accessToken"} {
		if token, ok := relaycore.RawString(fields[key]); ok && strings.TrimSpace(token) != "" {
			return strings.TrimSpace(token), true
		}
	}
	return "", false
}

// DecorateUpstream 补齐 kimi 要求的客户端标识头（差异 1）。
//
// 先调基类拿通用头（Content-Type / Accept / Authorization），再追加 kimi 特有的。
func (provider Provider) DecorateUpstream(request *http.Request, accessToken string) {
	provider.BaseProvider.DecorateUpstream(request, accessToken)
	request.Header.Set("User-Agent", kimiUserAgentPrefix+"/"+provider.version)
	request.Header.Set("X-Msh-Platform", kimiCodePlatform)
	request.Header.Set("X-Msh-Version", provider.version)

	headers := kimiidentity.ResolveDeviceHeaders(
		provider.accountRef,
		provider.profile,
		provider.credentialDeviceID,
		provider.host,
	)
	if headers.DeviceName != "" {
		request.Header.Set("X-Msh-Device-Name", headers.DeviceName)
	}
	if headers.DeviceModel != "" {
		request.Header.Set("X-Msh-Device-Model", headers.DeviceModel)
	}
	if headers.OSVersion != "" {
		request.Header.Set("X-Msh-Os-Version", headers.OSVersion)
	}
	if headers.DeviceID != "" {
		request.Header.Set("X-Msh-Device-Id", headers.DeviceID)
	}
}

// RewriteRequest 施加 kimi 的原生字段契约（差异 2）。
func (provider Provider) RewriteRequest(body []byte) (relaycore.RewriteResult, error) {
	rewritten, err := AdaptChatRequest(body)
	if err != nil {
		return relaycore.RewriteResult{}, err
	}
	return relaycore.RewriteResult{Body: rewritten}, nil
}

// AdaptChatRequest 把通用 OpenAI 字段翻译成 kimi 的原生契约。
//
// 规则（与 Node 侧 adaptKimiChatRequestBuffer 逐条对齐）：
//   - `reasoning_effort` → `thinking: {type: enabled, effort}`；
//     `none` / `off` → `{type: disabled}`；已带 `thinking` 时不动（原生优先）；
//   - `max_tokens` → `max_completion_tokens`；已带后者时不动；
//   - 流式请求补 `stream_options.include_usage`（缺它时上游不报 usage）。
//
// **不做**的事：不猜默认预算。Node 侧在两者都缺时会查 models.dev 的 output limits
// 兜底；Go 侧的模型元数据目前只有模态、没有 limits，因此这里**如实留空**而不是编一个
// 数字——编造预算会让上游按错误上限截断，比不传更糟。补齐需要先把 limits 引入 Go
// 的模型元数据（见 docs/plans/2026-10-17-relaycore-abstraction.md 的后续项）。
func AdaptChatRequest(body []byte) ([]byte, error) {
	fields, ok := relaycore.DecodeRawObject(body)
	if !ok {
		// 不是 JSON 对象：交回调用方按原样处理（relaycore 会据此交还 Canonical）。
		return body, nil
	}
	rawEffort, hasEffort := fields["reasoning_effort"]
	rawBudget, hasBudget := fields["max_tokens"]
	_, hasNativeBudget := fields["max_completion_tokens"]
	_, hasThinking := fields["thinking"]

	needsStreamUsage := false
	if stream, ok := relaycore.RawBool(fields["stream"]); ok && stream {
		if options, ok := relaycore.DecodeRawObject(fields["stream_options"]); !ok {
			needsStreamUsage = true
		} else if _, hasUsage := options["include_usage"]; !hasUsage {
			needsStreamUsage = true
		}
	}
	if !hasEffort && !hasBudget && !needsStreamUsage {
		return body, nil
	}

	delete(fields, "reasoning_effort")
	delete(fields, "max_tokens")

	// reasoning_effort → thinking（原生字段优先：已带 thinking 时不动）。
	if hasEffort && !hasThinking {
		if effort, ok := relaycore.RawString(rawEffort); ok {
			trimmed := strings.TrimSpace(effort)
			if trimmed != "" {
				if encoded, err := marshalThinking(trimmed); err == nil {
					fields["thinking"] = encoded
				}
			}
		}
	}
	// max_tokens → max_completion_tokens（原生字段优先）。
	if hasBudget && !hasNativeBudget {
		fields["max_completion_tokens"] = rawBudget
	}
	// 流式请求补 include_usage（缺它时上游不报 usage）。
	if needsStreamUsage {
		options, _ := relaycore.DecodeRawObject(fields["stream_options"])
		if options == nil {
			options = map[string]json.RawMessage{}
		}
		options["include_usage"] = json.RawMessage("true")
		encoded, err := json.Marshal(options)
		if err == nil {
			fields["stream_options"] = encoded
		}
	}

	encoded, err := json.Marshal(fields)
	if err != nil {
		return body, nil
	}
	return encoded, nil
}

// marshalThinking 把 effort 串翻译成 kimi 的 thinking 对象。
//
// `none` / `off` 是「显式关闭思考」的等价写法（与 Node 侧同判定）。
func marshalThinking(effort string) (json.RawMessage, error) {
	if effort == "none" || effort == "off" {
		return json.RawMessage(`{"type":"disabled"}`), nil
	}
	payload, err := json.Marshal(map[string]string{"type": "enabled", "effort": effort})
	if err != nil {
		return nil, err
	}
	return json.RawMessage(payload), nil
}
