package codebuddyfamilyrelay

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// ChatCompletionsPath 是家族上游**唯一**接受的路径（约束 1）：
	// `/v1/chat/completions` 实测 404 Route Not Found。
	ChatCompletionsPath = "/v2/chat/completions"
	// UserAgent 是上游网关要求的真实客户端标识。脚本默认 UA 会被 WAF 403
	// `{"code":10085,"msg":"请求不合法"}`；版本号本身不参与鉴权，只用于通过检查。
	// 它与渠道校验（code 11128）无关，后者只看会话 ID 家族（见 ConversationHeaders）。
	UserAgent = "CLI/2.63.2 CodeBuddy/2.63.2"

	// 渠道校验要求的会话 ID 家族（与 Node 侧 codebuddy-family-inference 同名同语义）。
	ConversationIDHeader        = "X-Conversation-ID"
	ConversationMessageIDHeader = "X-Conversation-Message-ID"
	ConversationRequestIDHeader = "X-Conversation-Request-ID"
	// RequestIDHeader 与 ConversationMessageIDHeader **同值**——官方就是这么发的
	// （2026-10-21 抓包：两个头逐字节相同），所以它同样参与渠道校验。
	RequestIDHeader = "X-Request-ID"
	// RootRequestIDHeader 与 ConversationRequestIDHeader 同值（官方行为）。
	RootRequestIDHeader = "X-Root-Request-ID"

	// 官方身份头（2026-10-21 抓包确认的完整集合）。实测**不参与**渠道校验与 WAF 检查
	// （删掉仍 200），发它们是为了让请求画像与官方一致，不留下可区分的差异。
	ProductHeader        = "X-Product"
	DomainHeader         = "X-Domain"
	IDETypeHeader        = "X-IDE-Type"
	IDENameHeader        = "X-IDE-Name"
	IDEVersionHeader     = "X-IDE-Version"
	AgentPurposeHeader   = "X-Agent-Purpose"
	AgentIntentHeader    = "X-Agent-Intent"
	AgentTypeHeader      = "X-Agent-Type"
	PrivateDataHeader    = "X-Private-Data"
	UserIDHeader         = "X-User-Id"
	CodebuddyRequestHead = "x-codebuddy-request"
	// IDEVersion 是官方身份头里的版本号（UA 里的版本同源）。
	IDEVersion = "2.161.4"
)

// stainlessHeaders 是官方底层 OpenAI SDK 注入的一整套运行时标识（官方 CLI 跑在 Node 上）。
// 实测不参与渠道校验（删掉仍 200），复刻只为消掉可区分的差异。
var stainlessHeaders = map[string]string{
	"X-Stainless-Arch":            "arm64",
	"X-Stainless-Lang":            "js",
	"X-Stainless-Os":              "MacOS",
	"X-Stainless-Package-Version": "6.25.0",
	"X-Stainless-Retry-Count":     "0",
	"X-Stainless-Runtime":         "node",
	"X-Stainless-Runtime-Version": "v26.3.0",
}

// domainByProvider 是官方 `X-Domain` 的取值：**站点根域名**（不是 origin，不带协议与端口）。
// 与 inferenceBaseURLs 同源，只差一个「取 hostname」。
var domainByProvider = map[string]string{
	"codebuddy":   "www.codebuddy.ai",
	"workbuddy":   "www.workbuddy.ai",
	"codebuddycn": "copilot.tencent.com",
	"workbuddycn": "copilot.tencent.com",
}

// ConversationHeaders 返回渠道校验必需的会话 ID 家族。
//
// 上游只要求这些头都**非空**、不校验格式（2026-10-21 实测：任意短串可过，空串 11128）。
// 官方客户端发 UUIDv7 形态（`01a15ede-5927-7289-86f7-0648bbaa2d32`），这里复刻该形状。
// Go 透传不持有客户端会话键，所以每次请求新建；Node 侧按会话键派生稳定的 conversation id。
func ConversationHeaders(now time.Time) map[string]string {
	messageID := newConversationID(now)
	requestID := newConversationID(now)
	conversationID := newConversationID(now)
	return map[string]string{
		ConversationIDHeader:        conversationID,
		ConversationMessageIDHeader: messageID,
		// 官方让这两对头同值，复刻它避免留下可区分的差异。
		RequestIDHeader:             messageID,
		ConversationRequestIDHeader: requestID,
		RootRequestIDHeader:         requestID,
	}
}

// TraceHeaders 返回官方底层 OpenAI SDK 的分布式 trace 头（W3C traceparent + B3 双格式）。
//
// 实测不参与渠道校验（删掉仍 200）；复刻它们只为让请求画像与官方一致。
func TraceHeaders() map[string]string {
	traceID := randomHex(16)
	spanID := randomHex(8)
	parentSpanID := randomHex(8)
	return map[string]string{
		"Traceparent":       "00-" + traceID + "-" + spanID + "-01",
		"B3":                traceID + "-" + spanID + "-1-" + parentSpanID,
		"X-B3-Traceid":      traceID,
		"X-B3-Parentspanid": parentSpanID,
		"X-B3-Spanid":       spanID,
		"X-B3-Sampled":      "1",
		"X-Trace-Id":        traceID,
	}
}

// BaggageHeader 返回引用会话 id 的 baggage（官方同样是引用关系，不是独立随机值）。
func BaggageHeader(conversationID string, conversationRequestID string) string {
	return "codebuddy.session_id=" + conversationID +
		",codebuddy.conversation_request_id=" + conversationRequestID
}

// randomHex 生成 n 字节的十六进制串；随机源失败时用时间戳兜底（头值非空即可）。
func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		filler := fmt.Sprintf("%0*x", n*2, time.Now().UnixNano())
		if len(filler) > n*2 {
			filler = filler[len(filler)-n*2:]
		}
		return filler
	}
	return hex.EncodeToString(buf)
}

// StainlessHeaders 返回官方底层 SDK 的运行时标识（复刻官方画像用）。
func StainlessHeaders() map[string]string {
	out := make(map[string]string, len(stainlessHeaders))
	for name, value := range stainlessHeaders {
		out[name] = value
	}
	return out
}

// IdentityHeaders 返回官方身份头（不含会话 ID 家族与鉴权）。
//
// uid 为空时不下发 `X-User-Id`：留一个空头比不发更容易被识别为异常。
func IdentityHeaders(provider string, uid string) map[string]string {
	headers := map[string]string{
		ProductHeader:        "SaaS",
		IDETypeHeader:        "CLI",
		IDENameHeader:        "CLI",
		IDEVersionHeader:     IDEVersion,
		AgentPurposeHeader:   "conversation",
		AgentIntentHeader:    "craft",
		AgentTypeHeader:      "main",
		PrivateDataHeader:    "false",
		CodebuddyRequestHead: "1",
	}
	if domain := domainByProvider[normalizeProvider(provider)]; domain != "" {
		headers[DomainHeader] = domain
	}
	if value := strings.TrimSpace(uid); value != "" {
		headers[UserIDHeader] = value
	}
	return headers
}

// newConversationID 生成官方同形的 UUIDv7 标识：`8-4-4-4-12` 十六进制，
// 前 48 位是毫秒时间戳，第 13 位固定 7（版本），第 17 位固定 8（RFC 4122 变体）。
// 随机源失败时退回纯时间戳填充：头值非空就能通过校验，不值得为此让整次请求失败。
func newConversationID(now time.Time) string {
	stamp := fmt.Sprintf("%012x", now.UnixMilli())
	if len(stamp) > 12 {
		stamp = stamp[len(stamp)-12:]
	}
	random := make([]byte, 10)
	if _, err := rand.Read(random); err != nil {
		// 兜底：用时间戳重复填充，形状仍合法、值仍非空。
		filler := strings.Repeat(stamp, 3)[:20]
		random = []byte(filler)
	}
	hexed := hex.EncodeToString(random) // 20 位
	variant := fmt.Sprintf("%02x", (hexed[3]&0x3f)|0x80)
	return stamp[0:8] + "-" + stamp[8:12] + "-7" + hexed[0:3] + "-" +
		variant + hexed[5:7] + "-" + hexed[7:19]
}

// ErrUnsupportedCredential 表示账号凭据不是家族原生登录态（无 access token 可取）。
//
// 调用方应据此把请求交回 Canonical：那边尊重账号自带的 Base URL 等差异，
// 透传只承诺承载「家族官方端点 + 原生凭据」这一种形态。
var ErrUnsupportedCredential = errors.New("家族透传凭据不受支持")

// FamilyProviders 是家族四支，与 Node 侧 codebuddy-family-layouts 的
// FAMILY_PROVIDERS 同集合（守卫测试会盯住两侧一致）。
var FamilyProviders = []string{"codebuddy", "codebuddycn", "workbuddy", "workbuddycn"}

// inferenceBaseURLs 是发行版级推理 endpoint：国内站两支共用 copilot.tencent.com，
// 国际站两支各用自己站点域名。与 Node 侧 CODEBUDDY_FAMILY_INFERENCE_BASE_URLS 同源，
// 但刻意与计费端点分开声明——计费端点变化与推理端点变化是两件独立的事。
var inferenceBaseURLs = map[string]string{
	"codebuddy":   "https://www.codebuddy.ai",
	"workbuddy":   "https://www.workbuddy.ai",
	"codebuddycn": "https://copilot.tencent.com",
	"workbuddycn": "https://copilot.tencent.com",
}

// IsFamilyProvider 判断 Provider 是否属于家族（大小写与空白归一）。
func IsFamilyProvider(provider string) bool {
	_, found := inferenceBaseURLs[normalizeProvider(provider)]
	return found
}

// InferenceBaseURL 返回该 Provider 的推理站点根；非家族 Provider 返回 false。
func InferenceBaseURL(provider string) (string, bool) {
	base, found := inferenceBaseURLs[normalizeProvider(provider)]
	return base, found
}

// InferenceEndpoint 返回完整上游 URL（站点根 + `/v2/chat/completions`）。
func InferenceEndpoint(provider string) (string, bool) {
	base, found := InferenceBaseURL(provider)
	if !found {
		return "", false
	}
	return base + ChatCompletionsPath, true
}

// normalizeProvider 归一化 Provider 名（与 Node 的 normalizeProvider 同口径）。
func normalizeProvider(provider string) string {
	return strings.ToLower(strings.TrimSpace(provider))
}

// AccessTokenFromCredential 从家族原生凭据里取共享 access token。
//
// 取法与 Go 侧账号策略一致（internal/adapters/accounts/nativeaccount 的
// generation_policy 读同一路径）：`credentials.auth.accessToken`（兼容
// `access_token` 写法）。取不到就是确定性属性，调用方交回 Canonical，
// 不要在这里猜别的字段。
func AccessTokenFromCredential(credential accountapp.Credential) (string, error) {
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil {
		return "", ErrUnsupportedCredential
	}
	return accessTokenFromPayload(native.Payload())
}

// UserIDFromCredential 从家族原生凭据里取账号 uid（官方 `X-User-Id` 的值）。
//
// 与 access token 同源（同一个 credentials 载荷的 account.uid），取不到返回空串：
// 该头只用于复刻官方画像，不下发不影响渠道校验。
func UserIDFromCredential(credential accountapp.Credential) string {
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil {
		return ""
	}
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(native.Payload(), &fields); err != nil {
		return ""
	}
	credentials, ok := decodeRawObject(fields["credentials"])
	if !ok {
		return ""
	}
	account, ok := decodeRawObject(credentials["account"])
	if !ok {
		return ""
	}
	uid, ok := rawString(account["uid"])
	if !ok {
		return ""
	}
	return strings.TrimSpace(uid)
}

// accessTokenFromPayload 从原生凭据载荷里取 access token（纯函数，便于独立测试）。
func accessTokenFromPayload(payload []byte) (string, error) {
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(payload, &fields); err != nil {
		return "", ErrUnsupportedCredential
	}
	credentials, ok := decodeRawObject(fields["credentials"])
	if !ok {
		return "", ErrUnsupportedCredential
	}
	auth, ok := decodeRawObject(credentials["auth"])
	if !ok {
		return "", ErrUnsupportedCredential
	}
	for _, key := range []string{"accessToken", "access_token"} {
		if token, ok := rawString(auth[key]); ok && strings.TrimSpace(token) != "" {
			return strings.TrimSpace(token), nil
		}
	}
	return "", ErrUnsupportedCredential
}
