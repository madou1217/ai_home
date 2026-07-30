// Package claudenativerelay 透传官方 Claude Runtime 已证明的 Messages 请求。
//
// 该入站适配器不解析或重编码正文，只替换数据库凭据并过滤逐跳 Header。
package claudenativerelay

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/internal/adapters/claude/transportpolicy"
)

const (
	// Path 与官方 Claude SDK 的 Messages 请求路径保持一致。
	Path = "/v1/messages"
	// MaxRequestBodyBytes 给原生 JSON 请求设置明确的内存外传上限。
	MaxRequestBodyBytes int64 = 16 * 1024 * 1024
	// officialMessagesEndpoint 是订阅 OAuth 唯一允许的真实目标。
	officialMessagesEndpoint = claudeauth.DefaultAPIBaseURL + Path
	// oauthBeta 是 Relay 根据数据库官方 OAuth 凭据补充的稳定认证 beta。
	oauthBeta = "oauth-2025-04-20"
	// nativeBetaQuery 是 Claude Code 2.1.220 为原生 Messages 请求追加的固定查询串。
	nativeBetaQuery = "beta=true"
	// maxRelayDuration 与官方 Claude Client 的长请求上限保持同一量级。
	maxRelayDuration = 10 * time.Minute
)

var (
	// ErrInvalidDependencies 表示 Handler 缺少鉴权、凭据或 HTTP Client。
	ErrInvalidDependencies = errors.New("Claude Native Relay 依赖无效")
	// ErrUnsupportedCredential 表示目标账号不是官方 Claude OAuth。
	ErrUnsupportedCredential = errors.New("Claude Native Relay 凭据不受支持")
)

// Authorizer 从本地可信租约中解析唯一 AccountRef。
type Authorizer interface {
	Authorize(request *http.Request) (accountcore.AccountRef, bool)
}

// CredentialResolver 延迟读取并刷新目标账号凭据。
type CredentialResolver interface {
	ResolveCredential(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountapp.Credential, error)
}

// HTTPClient 是 Relay 发起单个上游请求所需的最小端口。
type HTTPClient interface {
	Do(request *http.Request) (*http.Response, error)
}

// Dependencies 集中声明 Native Relay 的三个外部端口。
type Dependencies struct {
	Authorizer  Authorizer
	Credentials CredentialResolver
	Client      HTTPClient
}

// Handler 编排可信账号绑定、原始请求透传和响应流回写。
type Handler struct {
	authorizer  Authorizer
	credentials CredentialResolver
	client      HTTPClient
}

// NewHandler 创建默认失败关闭的 Claude Native Relay。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil ||
		dependencies.Credentials == nil ||
		dependencies.Client == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer:  dependencies.Authorizer,
		credentials: dependencies.Credentials,
		client:      dependencies.Client,
	}, nil
}

// ServeHTTP 在触网前完成租约鉴权、HTTP 合同和凭据类型校验。
func (handler *Handler) ServeHTTP(
	response http.ResponseWriter,
	request *http.Request,
) {
	if handler == nil ||
		handler.authorizer == nil ||
		handler.credentials == nil ||
		handler.client == nil {
		writeRelayError(
			response,
			http.StatusServiceUnavailable,
			"relay_unavailable",
			"Claude Native Relay 当前不可用",
		)
		return
	}
	accountRef, authorized := handler.authorizer.Authorize(request)
	if !authorized {
		writeRelayError(
			response,
			http.StatusUnauthorized,
			"unauthorized",
			"需要有效的 Claude Relay Token",
		)
		return
	}
	if !validRelayRequest(response, request) {
		return
	}
	credential, err := handler.credentials.ResolveCredential(
		request.Context(),
		accountRef,
	)
	if err != nil {
		writeRelayError(
			response,
			http.StatusServiceUnavailable,
			"relay_account_unavailable",
			"Claude Relay 账号当前不可用",
		)
		return
	}
	accessToken, err := nativeOAuthAccessToken(credential)
	if err != nil {
		writeRelayError(
			response,
			http.StatusUnprocessableEntity,
			"unsupported_relay_credential",
			"Claude Relay 账号必须使用官方 OAuth",
		)
		return
	}
	upstream, err := buildUpstreamRequest(request, accessToken)
	if err != nil {
		writeRelayError(
			response,
			http.StatusBadRequest,
			"invalid_relay_request",
			"Claude Relay 请求无效",
		)
		return
	}
	// Native SSE 可能跨越 Host 默认写超时；只为当前已鉴权 Relay 请求延长。
	_ = http.NewResponseController(response).SetWriteDeadline(
		time.Now().Add(maxRelayDuration),
	)
	upstreamResponse, err := handler.client.Do(upstream)
	if err != nil || upstreamResponse == nil || upstreamResponse.Body == nil {
		closeUpstreamResponse(upstreamResponse)
		writeRelayError(
			response,
			http.StatusBadGateway,
			"relay_upstream_unavailable",
			"Claude 上游暂时不可用",
		)
		return
	}
	defer upstreamResponse.Body.Close()

	copyResponseHeaders(response.Header(), upstreamResponse.Header)
	response.WriteHeader(upstreamResponse.StatusCode)
	_ = copyResponseBody(response, upstreamResponse.Body)
}

// validRelayRequest 校验不会改变原始正文的 HTTP 外层合同。
func validRelayRequest(
	response http.ResponseWriter,
	request *http.Request,
) bool {
	if request == nil || request.URL == nil || request.URL.Path != Path {
		writeRelayError(
			response,
			http.StatusNotFound,
			"route_not_found",
			"Claude Relay 路由不存在",
		)
		return false
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeRelayError(
			response,
			http.StatusMethodNotAllowed,
			"method_not_allowed",
			"Claude Relay 只接受 POST",
		)
		return false
	}
	if request.URL.ForceQuery ||
		request.URL.RawQuery != "" &&
			request.URL.RawQuery != nativeBetaQuery {
		writeRelayError(
			response,
			http.StatusBadRequest,
			"unexpected_query",
			"Claude Relay 不接受查询参数",
		)
		return false
	}
	mediaType, _, err := mime.ParseMediaType(
		request.Header.Get("Content-Type"),
	)
	if err != nil || mediaType != "application/json" {
		writeRelayError(
			response,
			http.StatusUnsupportedMediaType,
			"unsupported_media_type",
			"Claude Relay 只接受 application/json",
		)
		return false
	}
	if !hasNativeClaudeHeaders(request.Header) {
		writeRelayError(
			response,
			http.StatusBadRequest,
			"invalid_native_client_headers",
			"Claude Relay 缺少原生客户端标识",
		)
		return false
	}
	if request.Body == nil || request.ContentLength <= 0 {
		writeRelayError(
			response,
			http.StatusLengthRequired,
			"content_length_required",
			"Claude Relay 需要明确的 Content-Length",
		)
		return false
	}
	if request.ContentLength > MaxRequestBodyBytes {
		writeRelayError(
			response,
			http.StatusRequestEntityTooLarge,
			"request_too_large",
			"Claude Relay 请求体超过上限",
		)
		return false
	}
	return true
}

// hasNativeClaudeHeaders 验证稳定外层标识，不尝试生成或替代 attestation。
func hasNativeClaudeHeaders(header http.Header) bool {
	sessionID := header.Get("X-Claude-Code-Session-Id")
	return header.Get("x-app") == "cli" &&
		strings.HasPrefix(header.Get("User-Agent"), "claude-cli/") &&
		header.Get("anthropic-version") != "" &&
		header.Get("anthropic-beta") != "" &&
		validNativeSessionID(sessionID)
}

// validNativeSessionID 拒绝空白和控制字符，但不绑定官方未来的 ID 格式。
func validNativeSessionID(sessionID string) bool {
	return sessionID != "" &&
		len(sessionID) <= 128 &&
		strings.TrimSpace(sessionID) == sessionID &&
		!strings.ContainsAny(sessionID, " \t\r\n")
}

// containsHeaderToken 在多个逗号分隔 Header 中查找精确 beta。
func containsHeaderToken(values []string, expected string) bool {
	for _, value := range values {
		for token := range strings.SplitSeq(value, ",") {
			if strings.TrimSpace(token) == expected {
				return true
			}
		}
	}
	return false
}

// nativeOAuthAccessToken 只接受必须由官方 Runtime 证明的 OAuth 凭据。
func nativeOAuthAccessToken(
	credential accountapp.Credential,
) (string, error) {
	if !transportpolicy.RequiresNativeOAuth(credential) {
		return "", ErrUnsupportedCredential
	}
	switch auth := credential.(type) {
	case *claudeauth.OAuthAuth:
		if auth != nil && auth.AccessToken() != "" {
			return auth.AccessToken(), nil
		}
	case *claudeauth.OAuthTokenAuth:
		if auth != nil && auth.AccessToken() != "" {
			return auth.AccessToken(), nil
		}
	}
	return "", ErrUnsupportedCredential
}

// buildUpstreamRequest 保留原始 Body 和安全 Header，只替换数据库 OAuth。
func buildUpstreamRequest(
	incoming *http.Request,
	accessToken string,
) (*http.Request, error) {
	if incoming == nil ||
		incoming.Body == nil ||
		accessToken == "" ||
		strings.ContainsAny(accessToken, "\r\n") {
		return nil, ErrUnsupportedCredential
	}
	upstream, err := http.NewRequestWithContext(
		incoming.Context(),
		http.MethodPost,
		officialMessagesEndpoint,
		incoming.Body,
	)
	if err != nil {
		return nil, fmt.Errorf("创建 Claude Relay 上游请求失败: %w", err)
	}
	// 只会到达这里的非空查询已由入站合同限定为 beta=true。
	upstream.URL.RawQuery = incoming.URL.RawQuery
	upstream.ContentLength = incoming.ContentLength
	copyRequestHeaders(upstream.Header, incoming.Header)
	upstream.Header.Set("Authorization", "Bearer "+accessToken)
	ensureOAuthBeta(upstream.Header)
	if upstream.Header.Get("Accept-Encoding") == "" {
		upstream.Header.Set("Accept-Encoding", "identity")
	}
	return upstream, nil
}

// ensureOAuthBeta 只补充数据库凭据已经证明的 OAuth 认证能力，不改写原生
// Runtime 提供的其他 beta 或正文 attestation。
func ensureOAuthBeta(header http.Header) {
	if containsHeaderToken(header.Values("anthropic-beta"), oauthBeta) {
		return
	}
	header.Add("anthropic-beta", oauthBeta)
}

// copyResponseBody 逐块刷新 SSE，也兼容普通 JSON 错误响应。
func copyResponseBody(
	response http.ResponseWriter,
	body io.Reader,
) error {
	buffer := make([]byte, 32*1024)
	flusher, canFlush := response.(http.Flusher)
	for {
		read, readErr := body.Read(buffer)
		if read > 0 {
			if _, writeErr := response.Write(buffer[:read]); writeErr != nil {
				return writeErr
			}
			if canFlush {
				flusher.Flush()
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return nil
			}
			return readErr
		}
	}
}

// closeUpstreamResponse 关闭错误路径中非空的上游响应。
func closeUpstreamResponse(response *http.Response) {
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
}
