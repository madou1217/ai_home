package responses

import (
	"bytes"
	"context"
	"net/http"
	"net/url"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/internal/adapters/codex/codexidentity"
)

const (
	// chatGPTCodexBaseURL 与官方 Codex rust-v0.146.0 的 OAuth Provider 基址一致。
	chatGPTCodexBaseURL = "https://chatgpt.com/backend-api/codex"
	// responsesPath 是官方 ResponsesClient 使用的相对端点。
	responsesPath = "responses"
)

// authProjection 是一次请求所需的最小凭据投影。
//
// 该值不得进入日志或错误格式化。
type authProjection struct {
	baseURL   string
	token     string
	accountID string
	fedRAMP   bool
	kind      codexauth.AuthKind
	// clientVersion 是本次请求自报的 Codex 客户端版本，来自版本解析器，见 codexidentity。
	clientVersion string
}

// projectAuth 只接受领域层已经校验的 Codex OAuth 或 API Key。
func projectAuth(credential accountapp.Credential) (authProjection, error) {
	switch auth := credential.(type) {
	case *codexauth.APIKeyAuth:
		if auth == nil || auth.APIKey() == "" || auth.BaseURL() == "" {
			return authProjection{}, ErrInvalidInvocation
		}
		return authProjection{
			baseURL: auth.BaseURL(),
			token:   auth.APIKey(),
			kind:    codexauth.AuthKindAPIKey,
		}, nil
	case *codexauth.OAuthAuth:
		if auth == nil || auth.AccessToken() == "" {
			return authProjection{}, ErrInvalidInvocation
		}
		return authProjection{
			baseURL:   chatGPTCodexBaseURL,
			token:     auth.AccessToken(),
			accountID: auth.UpstreamAccountID(),
			fedRAMP:   auth.IsFedRAMP(),
			kind:      codexauth.AuthKindOAuth,
		}, nil
	default:
		return authProjection{}, ErrInvalidInvocation
	}
}

// buildHTTPRequest 创建凭据只存在于 Header 的 POST 请求。
func buildHTTPRequest(
	ctx context.Context,
	auth authProjection,
	payload []byte,
	profile requestProfile,
) (*http.Request, error) {
	endpoint, err := responsesEndpoint(auth.baseURL)
	if err != nil || auth.token == "" {
		return nil, ErrInvalidInvocation
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		endpoint,
		bytes.NewReader(payload),
	)
	if err != nil {
		return nil, ErrInvalidInvocation
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream")
	if err := applyAuthenticationHeaders(request, auth); err != nil {
		return nil, err
	}
	profile.applyHeaders(request.Header)
	return request, nil
}

// applyAuthenticationHeaders 统一投影 Codex OAuth/API Key 的认证与客户端身份 Header。
//
// 凭据只进入目标请求的 Header，不进入 URL、日志或错误文本。
func applyAuthenticationHeaders(
	request *http.Request,
	auth authProjection,
) error {
	if request == nil || auth.token == "" {
		return ErrInvalidInvocation
	}
	request.Header.Set("Authorization", "Bearer "+auth.token)
	version := auth.clientVersion
	if version == "" {
		version = codexidentity.Floor
	}
	request.Header.Set("Originator", codexidentity.Originator)
	request.Header.Set("User-Agent", codexidentity.UserAgent(version))
	request.Header.Set("Version", version)
	if auth.accountID != "" {
		request.Header.Set("ChatGPT-Account-ID", auth.accountID)
	}
	if auth.fedRAMP {
		request.Header.Set("X-OpenAI-Fedramp", "true")
	}
	return nil
}

// responsesEndpoint 在账号级 Base URL 后精确追加一次 responses。
func responsesEndpoint(baseURL string) (string, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil ||
		parsed.Scheme == "" ||
		parsed.Host == "" ||
		parsed.RawQuery != "" ||
		parsed.Fragment != "" {
		return "", ErrInvalidInvocation
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/" + responsesPath
	parsed.RawPath = ""
	return parsed.String(), nil
}
