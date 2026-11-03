package codebuddyfamilyrelay

import (
	"net/http"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
	familyfailure "github.com/madou1217/ai_home/internal/adapters/codebuddyfamily/upstreamfailure"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

// Provider 是家族在 relaycore 上的差异面实现。
//
// 家族与「朴素 OpenAI 兼容端点」的差异**全部集中在这个文件**（六条）：
//  1. 上游路径 `/v2/chat/completions`（非标准）—— 由 Endpoint 解析；
//  2. 凭据取法 `credentials.auth.accessToken`（家族原生登录态）—— AccessToken；
//  3. 四条硬约束改写（stream 恒 true / 首条补 system / tool_choice 翻译）—— RewriteRequest；
//  4. 真实客户端 UA + Origin/Referer（否则 WAF 403）—— DecorateUpstream；
//  5. 错误信封是腾讯 `{code,msg,displayMsg}` —— ClassifyFailure；
//  6. 聚合兜底 id 前缀 —— 在 AggregateSSE 包装里。
//
// 其余一切（尝试循环、换号判定、响应交付、记账、交还 Canonical）由 relaycore.Handler
// 承载，本文件不重复实现。
type Provider struct {
	relaycore.BaseProvider
	// systemPrompt 覆盖补位文案；为空时用 DefaultSystemPrompt。
	systemPrompt string
	// endpoint 覆盖上游 URL 解析（测试与运维注入点）。
	endpoint func(provider string) (string, bool)
	// providerID 是本次请求实际使用的家族支（四支共用本类型，故不能写死在基类里）。
	providerID string
	// userID 是账号 uid，用于官方身份头 X-User-Id（复刻官方画像；为空则不下发该头）。
	userID string
}

// 编译期确认家族实现满足 relaycore 契约。
var _ relaycore.Provider = Provider{}

// ProviderOptions 是构造家族 Provider 的可注入项。
type ProviderOptions struct {
	// ProviderID 是具体家族支（codebuddy / codebuddycn / workbuddy / workbuddycn）。
	ProviderID string
	// DefaultSystemPrompt 覆盖补位文案。
	DefaultSystemPrompt string
	// Endpoint 覆盖上游 URL 解析（默认 InferenceEndpoint）。
	Endpoint func(provider string) (string, bool)
}

// NewProvider 构造家族 Provider。
func NewProvider(options ProviderOptions) Provider {
	providerID := normalizeProvider(options.ProviderID)
	endpoint := options.Endpoint
	if endpoint == nil {
		endpoint = InferenceEndpoint
	}
	base := relaycore.NewBaseProvider(providerID, "")
	return Provider{
		BaseProvider: base,
		systemPrompt: strings.TrimSpace(options.DefaultSystemPrompt),
		endpoint:     endpoint,
		providerID:   providerID,
	}
}

// ID 返回本次服务的家族支。
func (provider Provider) ID() string { return provider.providerID }

// Resolve 按账号所属支返回对应的 Provider 变体（家族四支共用一个 Handler）。
//
// 差异只在该支的站点根（Origin/Referer 与上游 URL），因此换一个 providerID 即可，
// 其余差异（改写 / UA / 信封）四支完全相同。
func (provider Provider) Resolve(input relaycore.ResolveInput) (relaycore.Provider, bool) {
	normalized := normalizeProvider(input.ProviderID)
	if !IsFamilyProvider(normalized) {
		return nil, false
	}
	resolved := provider
	resolved.providerID = normalized
	// 账号 uid 与 access token 同源（同一个 credentials 载荷），从同一处取，
	// 避免两处口径分叉。取不到只是不下发 X-User-Id，不影响渠道校验。
	resolved.userID = UserIDFromCredential(input.Credential)
	return resolved, true
}

// Endpoint 解析家族上游 URL（差异 1：站点根 + `/v2/chat/completions`）。
func (provider Provider) Endpoint() (string, bool) {
	return provider.endpoint(provider.providerID)
}

// AccessToken 从家族原生凭据里取共享 access token（差异 2）。
func (provider Provider) AccessToken(credential accountapp.Credential) (string, error) {
	return AccessTokenFromCredential(credential)
}

// RewriteRequest 施加四条硬约束（差异 3）。
func (provider Provider) RewriteRequest(body []byte) (relaycore.RewriteResult, error) {
	rewritten, err := RewriteRequestBody(body, RewriteOptions{
		DefaultSystemPrompt: provider.systemPrompt,
	})
	if err != nil {
		return relaycore.RewriteResult{}, err
	}
	return relaycore.RewriteResult{
		Body:         rewritten.Body,
		Degradations: rewritten.Degradations,
	}, nil
}

// DecorateUpstream 补齐家族上游要求的外层标识（差异 4）。
//
// 先调基类拿通用头（Content-Type / Accept / Authorization），再追加家族特有的 ——
// 覆盖时漏掉基类那几行是这类改写的典型缺陷。
//
// 会话 ID 家族是渠道校验的必需项：缺任一个或为空，上游回 400 code 11128「request illegal」
// （2026-10-21 抓官方 CLI 后在真上游逐项删除确认，见 ConversationHeaders）。
//
// 刻意**不发** Origin / Referer：官方 CLI 身份不发这两个头（浏览器语义头，只有桌面/VSCode
// 身份才带）。此前本端补发它们，反而是一处与官方不符的差异。
func (provider Provider) DecorateUpstream(request *http.Request, accessToken string) {
	provider.BaseProvider.DecorateUpstream(request, accessToken)
	request.Header.Set("User-Agent", UserAgent)
	request.Header.Set("X-Requested-With", "XMLHttpRequest")
	for name, value := range IdentityHeaders(provider.providerID, provider.userID) {
		request.Header.Set(name, value)
	}
	for name, value := range StainlessHeaders() {
		request.Header.Set(name, value)
	}
	for name, value := range TraceHeaders() {
		request.Header.Set(name, value)
	}
	conversation := ConversationHeaders(time.Now())
	for name, value := range conversation {
		request.Header.Set(name, value)
	}
	// baggage 引用会话 id，必须在它们算出来之后再写。
	request.Header.Set("Baggage", BaggageHeader(
		conversation[ConversationIDHeader],
		conversation[ConversationRequestIDHeader],
	))
}

// ClassifyFailure 解析腾讯信封（差异 5）。
func (provider Provider) ClassifyFailure(
	statusCode int,
	header http.Header,
	body []byte,
	now time.Time,
) (sharedfailure.Classification, error) {
	return familyfailure.ObserveHTTP(statusCode, header, body, now)
}
