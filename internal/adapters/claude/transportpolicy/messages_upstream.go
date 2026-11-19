package transportpolicy

// 本文件是「原生 Messages 透传目标」的唯一投影点。
//
// 为什么需要它：此前「这个凭据能否走原生透传」散落在三处各自推导——
// GatewayPolicy.TransportFor、relay 的 attempt、以及 relay 的钉选来源——
// 每一处都用 credential 的具体类型做 switch，并把上游端点写死成官方地址。
// 新增一种凭据形态（厂商 API Key、厂商 OAuth token…）就要同时改三处，
// 而且 relay 与 policy 可能给出不一致的答案。
//
// 现在只有这一个抽象：凭据 → MessagesTarget（端点 + 认证头 + 官方客户端/oauth
// beta 两个语义开关）。调用方依赖该接口而不依赖具体凭据类型；新增厂商或凭据形态
// 只需增加一个 MessagesUpstream 实现并加入链，不需要改动 relay 的编排逻辑。
//
// 安全属性保持不变：投影只接受**已知**端点（官方 API 或厂商契约里登记的
// Anthropic 兼容端点），绝不会把任意第三方 Base URL 直接当成透传目标。

import (
	"net/url"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	vendorendpoints "github.com/madou1217/ai_home/contracts/vendor-endpoints"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
)

// MessagesTarget 是一次原生透传所需的完整上游投影。
//
// 该值包含进程内明文凭据，禁止进入日志、错误文本或持久化。
type MessagesTarget struct {
	// Endpoint 是完整的 Messages 信封端点（含 /v1/messages）。
	Endpoint string
	// HeaderName/HeaderValue 是上游认证头；官方 OAuth 用 Authorization Bearer，
	// Anthropic 兼容的 API Key 用 x-api-key。
	HeaderName  string
	HeaderValue string
	// OfficialClient 表示需要补 Claude Code 官方客户端标识头。
	//
	// 只有官方端点上的订阅 OAuth 为真：第三方兼容端点按官方客户端合同发送既无
	// 依据，也可能被代理拒绝。
	OfficialClient bool
	// OAuthBeta 表示需要补 oauth beta 头；同样只属于真 OAuth。
	OAuthBeta bool
}

// IsValid 判断目标是否可用于发起上游请求。
func (target MessagesTarget) IsValid() bool {
	return target.Endpoint != "" &&
		strings.TrimSpace(target.HeaderName) != "" &&
		target.HeaderValue != "" &&
		!strings.ContainsAny(target.HeaderValue, "\r\n")
}

// MessagesUpstream 把领域凭据投影成原生 Messages 上游目标。
//
// ok=false 表示该凭据不能走原生透传；调用方必须回落到 Canonical，
// 不得据此跳过账号（透传是传输优化，不改变调度选择）。
type MessagesUpstream interface {
	Project(credential accountapp.Credential) (MessagesTarget, bool)
}

// OfficialMessagesEndpoint 是 Anthropic 官方 Messages 端点。
const OfficialMessagesEndpoint = claudeauth.DefaultAPIBaseURL + "/v1/messages"

// OfficialOAuthUpstream 投影官方端点上的订阅 OAuth 凭据。
type OfficialOAuthUpstream struct{}

// Project 只接受官方端点上的 OAuth；第三方中转的 OAuth token 不在此列。
func (OfficialOAuthUpstream) Project(
	credential accountapp.Credential,
) (MessagesTarget, bool) {
	if !RequiresNativeOAuth(credential) {
		return MessagesTarget{}, false
	}
	var token string
	switch auth := credential.(type) {
	case *claudeauth.OAuthAuth:
		if auth != nil {
			token = auth.AccessToken()
		}
	case *claudeauth.OAuthTokenAuth:
		if auth != nil {
			token = auth.AccessToken()
		}
	}
	if token == "" {
		return MessagesTarget{}, false
	}
	target := MessagesTarget{
		Endpoint:       OfficialMessagesEndpoint,
		HeaderName:     "Authorization",
		HeaderValue:    "Bearer " + token,
		OfficialClient: true,
		OAuthBeta:      true,
	}
	return target, target.IsValid()
}

// VendorMessagesUpstream 投影双协议厂商的 API Key 凭据。
//
// 账号可以配在 claude（Anthropic 兼容地址）或 codex（OpenAI 兼容地址）：
// 两种形态都通过厂商契约解析出同一厂商的 Anthropic 兼容端点，用同一个
// API Key 以 x-api-key 访问。契约之外的地址一律不投影——猜一个「去掉
// /anthropic 再拼 /v1」的规则会把任意代理指向错误上游。
type VendorMessagesUpstream struct{}

// Project 只接受厂商契约登记过的静态 API Key 端点。
func (VendorMessagesUpstream) Project(
	credential accountapp.Credential,
) (MessagesTarget, bool) {
	apiKey, baseURL, ok := staticAPIKeyEndpoint(credential)
	if !ok {
		return MessagesTarget{}, false
	}
	resolution, found := vendorendpoints.Resolve(baseURL)
	if !found {
		return MessagesTarget{}, false
	}
	anthropicBaseURL := strings.TrimSpace(
		resolution.ProtocolBaseURL(vendorendpoints.ProtocolAnthropic),
	)
	if anthropicBaseURL == "" {
		return MessagesTarget{}, false
	}
	target := MessagesTarget{
		Endpoint:    vendorMessagesEndpoint(anthropicBaseURL),
		HeaderName:  "x-api-key",
		HeaderValue: apiKey,
	}
	if target.Endpoint == "" {
		return MessagesTarget{}, false
	}
	return target, target.IsValid()
}

// staticAPIKeyEndpoint 读取静态 API Key 凭据的「密钥 + Base URL」。
//
// 这是本包唯一需要认识具体凭据类型的地方；新增 Provider 时在此加一个分支。
func staticAPIKeyEndpoint(credential accountapp.Credential) (string, string, bool) {
	switch typed := credential.(type) {
	case *claudeauth.APIKeyAuth:
		if typed == nil {
			return "", "", false
		}
		apiKey, baseURL := typed.APIKey(), typed.BaseURL()
		if apiKey == "" || baseURL == "" {
			return "", "", false
		}
		return apiKey, baseURL, true
	case *codexauth.APIKeyAuth:
		if typed == nil {
			return "", "", false
		}
		apiKey, baseURL := typed.APIKey(), typed.BaseURL()
		if apiKey == "" || baseURL == "" {
			return "", "", false
		}
		return apiKey, baseURL, true
	default:
		return "", "", false
	}
}

// vendorMessagesEndpoint 把厂商的 Anthropic 兼容基址补成完整 Messages 端点。
//
// 兼容基址可能是 …/anthropic、…/apps/anthropic，也可能已经带 /v1。
func vendorMessagesEndpoint(baseURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil ||
		parsed.Scheme == "" ||
		parsed.Host == "" ||
		parsed.RawQuery != "" ||
		parsed.Fragment != "" {
		return ""
	}
	path := strings.TrimRight(parsed.EscapedPath(), "/")
	switch {
	case strings.HasSuffix(path, "/v1/messages"):
	case strings.HasSuffix(path, "/v1"):
		path += "/messages"
	default:
		path += "/v1/messages"
	}
	parsed.RawPath = path
	unescaped, err := url.PathUnescape(path)
	if err != nil {
		return ""
	}
	parsed.Path = unescaped
	return parsed.String()
}

// MessagesUpstreamChain 依次尝试多个投影，第一个成功者胜出。
type MessagesUpstreamChain struct {
	policies []MessagesUpstream
}

// NewMessagesUpstreamChain 创建顺序敏感的投影链。
func NewMessagesUpstreamChain(
	policies ...MessagesUpstream,
) *MessagesUpstreamChain {
	chain := &MessagesUpstreamChain{
		policies: make([]MessagesUpstream, 0, len(policies)),
	}
	for _, policy := range policies {
		if policy != nil {
			chain.policies = append(chain.policies, policy)
		}
	}
	return chain
}

// Project 返回第一个可用投影。
func (chain *MessagesUpstreamChain) Project(
	credential accountapp.Credential,
) (MessagesTarget, bool) {
	if chain == nil || credential == nil {
		return MessagesTarget{}, false
	}
	for _, policy := range chain.policies {
		if target, ok := policy.Project(credential); ok {
			return target, true
		}
	}
	return MessagesTarget{}, false
}

// Supports 判断凭据是否可被该链投影（供策略层复用同一判定）。
func (chain *MessagesUpstreamChain) Supports(
	credential accountapp.Credential,
) bool {
	_, ok := chain.Project(credential)
	return ok
}

// NewDefaultMessagesUpstream 创建生产默认投影链：官方 OAuth 优先，其次厂商 API Key。
func NewDefaultMessagesUpstream() *MessagesUpstreamChain {
	return NewMessagesUpstreamChain(
		OfficialOAuthUpstream{},
		VendorMessagesUpstream{},
	)
}
