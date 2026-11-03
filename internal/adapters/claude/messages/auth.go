package messages

import (
	"bytes"
	"context"
	"net/http"
	"net/url"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
)

const (
	// anthropicVersion 是当前 Messages 公共 API 的稳定版本。
	anthropicVersion = "2023-06-01"
	// betaOAuth 是 Claude.ai OAuth Bearer 认证所需的官方 beta。
	betaOAuth = "oauth-2025-04-20"
)

// authProfile 是单次请求所需的最小认证和端点投影。
type authProfile struct {
	endpoint    string
	headerName  string
	headerValue string
	oauthBeta   bool
	// officialClient 仅对官方端点上的订阅 OAuth 为真。
	//
	// 它与 oauthBeta 不是一回事：第三方 OAuth-token 中转端点同样需要 oauth beta，
	// 但那不是 Claude Code 订阅通道，按官方客户端合同发送既无依据也可能被代理拒绝。
	officialClient bool
}

// authSummary 是不含凭据的测试与诊断投影。
type authSummary struct {
	Endpoint   string
	HeaderName string
	OAuthBeta  bool
}

// safeSummary 返回不会泄漏 Token 或 API Key 的认证摘要。
func (profile authProfile) safeSummary() authSummary {
	return authSummary{
		Endpoint:   profile.endpoint,
		HeaderName: profile.headerName,
		OAuthBeta:  profile.oauthBeta,
	}
}

// projectAuth 把 Claude 凭据投影为精确 HTTP 认证合同。
//
// 订阅 OAuth 仍然优先由 Native Relay 保留官方客户端字节证明，但那条通道只对
// Claude 官方客户端存在。Codex 等其他客户端只能经 Canonical 转码，因此本投影
// 必须能承载订阅 OAuth，否则跨协议固定账号（aih codex relay claude N）无法成立。
// 传输选择由 transportpolicy.GatewayPolicy 决定，本函数只负责能力投影。
func projectAuth(credential accountapp.Credential) (authProfile, error) {
	switch auth := credential.(type) {
	case *claudeauth.OAuthAuth:
		if auth == nil {
			return authProfile{}, ErrInvalidInvocation
		}
		// 可刷新订阅 OAuth 没有独立 Base URL，始终指向官方 Messages 端点。
		profile, err := newBearerProfile(
			claudeauth.DefaultAPIBaseURL,
			auth.AccessToken(),
			true,
		)
		if err != nil {
			return authProfile{}, err
		}
		// 只有这一条分支是官方端点上的订阅 OAuth。
		profile.officialClient = true
		return profile, nil
	case *claudeauth.OAuthTokenAuth:
		if auth == nil {
			return authProfile{}, ErrInvalidInvocation
		}
		return newBearerProfile(auth.BaseURL(), auth.AccessToken(), true)
	case *claudeauth.APIKeyAuth:
		if auth == nil {
			return authProfile{}, ErrInvalidInvocation
		}
		return newAuthProfile(
			auth.BaseURL(),
			"x-api-key",
			auth.APIKey(),
			false,
		)
	case *claudeauth.AuthTokenAuth:
		if auth == nil {
			return authProfile{}, ErrInvalidInvocation
		}
		return newBearerProfile(auth.BaseURL(), auth.AuthToken(), false)
	default:
		return authProfile{}, ErrInvalidInvocation
	}
}

// newBearerProfile 创建 Authorization Bearer 投影。
func newBearerProfile(
	baseURL string,
	token string,
	oauthBeta bool,
) (authProfile, error) {
	if token == "" {
		return authProfile{}, ErrInvalidInvocation
	}
	return newAuthProfile(
		baseURL,
		"Authorization",
		"Bearer "+token,
		oauthBeta,
	)
}

// newAuthProfile 创建端点与 Header 已完成校验的认证投影。
func newAuthProfile(
	baseURL string,
	headerName string,
	headerValue string,
	oauthBeta bool,
) (authProfile, error) {
	endpoint, err := messagesEndpoint(baseURL)
	if err != nil || headerName == "" || headerValue == "" {
		return authProfile{}, ErrInvalidInvocation
	}
	return authProfile{
		endpoint:    endpoint,
		headerName:  headerName,
		headerValue: headerValue,
		oauthBeta:   oauthBeta,
	}, nil
}

// messagesEndpoint 同时支持 host、带 /v1 的 base URL 和显式 Messages 端点。
func messagesEndpoint(baseURL string) (string, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil ||
		parsed.Scheme == "" ||
		parsed.Host == "" ||
		parsed.RawQuery != "" ||
		parsed.Fragment != "" {
		return "", ErrInvalidInvocation
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
	parsed.Path, err = url.PathUnescape(path)
	if err != nil {
		return "", ErrInvalidInvocation
	}
	return parsed.String(), nil
}

// buildHTTPRequest 创建不携带客户端入站 Header 的独立上游请求。
func buildHTTPRequest(
	ctx context.Context,
	auth authProfile,
	encoded encodedRequest,
) (*http.Request, error) {
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		auth.endpoint,
		bytes.NewReader(encoded.payload),
	)
	if err != nil {
		return nil, ErrInvalidInvocation
	}
	request.Header.Set("Accept", "text/event-stream")
	request.Header.Set("Accept-Encoding", "identity")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("anthropic-version", anthropicVersion)
	request.Header.Set(auth.headerName, auth.headerValue)
	applyClaudeCodeIdentity(request.Header, auth.officialClient)

	betas := append([]string(nil), encoded.betaHeaders...)
	if auth.oauthBeta {
		// Claude.ai OAuth 是 Claude Code 订阅调用合同，不是通用 API Key。
		// 两个 beta 值均取自官方 claude 二进制（非自造），但"官方是否在每次
		// OAuth 请求上同时声明二者"尚未经真实上游验证，属于待验收项。
		betas = appendUniqueBeta(betas, betaClaudeCode)
		betas = appendUniqueBeta(betas, betaOAuth)
	}
	if len(betas) > 0 {
		request.Header.Set("anthropic-beta", strings.Join(betas, ","))
	}
	return request, nil
}
