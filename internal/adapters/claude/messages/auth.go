package messages

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"net/url"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/internal/adapters/claude/transportpolicy"
)

const (
	// anthropicVersion 是当前 Messages 公共 API 的稳定版本。
	anthropicVersion = "2023-06-01"
	// betaOAuth 是 Claude.ai OAuth Bearer 认证所需的官方 beta。
	betaOAuth = "oauth-2025-04-20"
	// nativeClaudeUserAgent 与本机已验证的官方 Claude Code 2.1.220 合同一致。
	nativeClaudeUserAgent = "claude-cli/2.1.220 (external, cli)"
	// nativeBetaQuery 与官方 Claude Code beta Messages 请求一致。
	nativeBetaQuery = "beta=true"
)

// authProfile 是单次请求所需的最小认证和端点投影。
type authProfile struct {
	endpoint    string
	headerName  string
	headerValue string
	oauthBeta   bool
	nativeOAuth bool
}

// authSummary 是不含凭据的测试与诊断投影。
type authSummary struct {
	Endpoint    string
	HeaderName  string
	OAuthBeta   bool
	NativeOAuth bool
}

// safeSummary 返回不会泄漏 Token 或 API Key 的认证摘要。
func (profile authProfile) safeSummary() authSummary {
	return authSummary{
		Endpoint:    profile.endpoint,
		HeaderName:  profile.headerName,
		OAuthBeta:   profile.oauthBeta,
		NativeOAuth: profile.nativeOAuth,
	}
}

// projectAuth 把允许 Go 直连的 Claude 凭据投影为精确 HTTP 认证合同。
func projectAuth(credential accountapp.Credential) (authProfile, error) {
	switch auth := credential.(type) {
	case *claudeauth.OAuthAuth:
		if auth == nil {
			return authProfile{}, ErrInvalidInvocation
		}
		return newNativeOAuthProfile(
			claudeauth.DefaultAPIBaseURL,
			auth.AccessToken(),
		)
	case *claudeauth.OAuthTokenAuth:
		if auth == nil {
			return authProfile{}, ErrInvalidInvocation
		}
		if transportpolicy.RequiresNativeOAuth(auth) {
			return newNativeOAuthProfile(auth.BaseURL(), auth.AccessToken())
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

// newNativeOAuthProfile 创建保留 Claude Code 原生请求外层合同的认证投影。
func newNativeOAuthProfile(baseURL string, token string) (authProfile, error) {
	profile, err := newBearerProfile(baseURL, token, true)
	if err != nil {
		return authProfile{}, err
	}
	profile.nativeOAuth = true
	return profile, nil
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
	if auth.nativeOAuth {
		sessionID, sessionErr := newNativeSessionID()
		if sessionErr != nil {
			return nil, ErrInvalidInvocation
		}
		request.Header.Set("x-app", "cli")
		request.Header.Set("User-Agent", nativeClaudeUserAgent)
		request.Header.Set("X-Claude-Code-Session-Id", sessionID)
		request.URL.RawQuery = nativeBetaQuery
	}

	betas := append([]string(nil), encoded.betaHeaders...)
	if auth.oauthBeta {
		// Claude.ai OAuth 是 Claude Code 订阅调用合同，不是通用 API Key。
		// 官方客户端对 agentic Messages 同时声明客户端和 OAuth 两个 beta。
		betas = appendUniqueBeta(betas, betaClaudeCode)
		betas = appendUniqueBeta(betas, betaOAuth)
	}
	if len(betas) > 0 {
		request.Header.Set("anthropic-beta", strings.Join(betas, ","))
	}
	return request, nil
}

// newNativeSessionID 创建符合 Claude Code 请求合同的随机 UUID 形态标识。
func newNativeSessionID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	encoded := make([]byte, 36)
	hex.Encode(encoded[0:8], value[0:4])
	encoded[8] = '-'
	hex.Encode(encoded[9:13], value[4:6])
	encoded[13] = '-'
	hex.Encode(encoded[14:18], value[6:8])
	encoded[18] = '-'
	hex.Encode(encoded[19:23], value[8:10])
	encoded[23] = '-'
	hex.Encode(encoded[24:36], value[10:16])
	return string(encoded), nil
}
