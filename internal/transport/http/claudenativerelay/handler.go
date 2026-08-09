// Package claudenativerelay 透传官方 Claude Runtime 已证明的 Messages 请求。
//
// 该入站适配器不解析或重编码正文，只替换数据库凭据并过滤逐跳 Header。
package claudenativerelay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/internal/adapters/attemptfailure"
	"github.com/madou1217/ai_home/internal/adapters/claude/transportpolicy"
	claudefailure "github.com/madou1217/ai_home/internal/adapters/claude/upstreamfailure"
	gatewaycontract "github.com/madou1217/ai_home/internal/contracts/claudegateway"
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
	// nativeBetaQuery 是当前官方 Claude Code/SDK 的原生 Messages 查询合同。
	nativeBetaQuery = "beta=true"
	// maxRelayDuration 与官方 Claude Client 的长请求上限保持同一量级。
	maxRelayDuration = 10 * time.Minute
	// maxRelayAttempts 与 Canonical 编排的上游尝试上限保持一致。
	//
	// 账号池很大时不设上限会让单个请求长时间打转，客户端只观察到超时。
	maxRelayAttempts = 4
)

var (
	// ErrInvalidDependencies 表示 Handler 缺少任一必需外部端口或时钟。
	ErrInvalidDependencies = errors.New("Claude Native Relay 依赖无效")
	// ErrUnsupportedCredential 表示目标账号不是官方 Claude OAuth。
	ErrUnsupportedCredential = errors.New("Claude Native Relay 凭据不受支持")
)

// Authorizer 从本地可信租约中解析唯一 AccountRef。
type Authorizer interface {
	Authorize(
		request *http.Request,
	) (accountcore.AccountRef, runtimecore.ModelID, bool)
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

// Dependencies 集中声明 Native Relay 的鉴权、凭据、传输和运行态端口。
type Dependencies struct {
	Authorizer Authorizer
	// Accounts 在没有租约时按调度顺序提供账号；为空表示只服务租约调用方。
	Accounts       AccountSource
	Credentials    CredentialResolver
	Client         HTTPClient
	Attempts       inferencegateway.AttemptRecorder
	ModelRefreshes inferencegateway.ModelRefreshScheduler
	Clock          func() time.Time
}

// Handler 编排可信账号绑定、原始请求透传和响应流回写。
type Handler struct {
	authorizer     Authorizer
	accounts       AccountSource
	credentials    CredentialResolver
	client         HTTPClient
	attempts       inferencegateway.AttemptRecorder
	modelRefreshes inferencegateway.ModelRefreshScheduler
	clock          func() time.Time
}

// NewHandler 创建默认失败关闭的 Claude Native Relay。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil ||
		dependencies.Credentials == nil ||
		dependencies.Client == nil ||
		dependencies.Attempts == nil ||
		dependencies.ModelRefreshes == nil ||
		dependencies.Clock == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer:     dependencies.Authorizer,
		accounts:       dependencies.Accounts,
		credentials:    dependencies.Credentials,
		client:         dependencies.Client,
		attempts:       dependencies.Attempts,
		modelRefreshes: dependencies.ModelRefreshes,
		clock:          dependencies.Clock,
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
		handler.client == nil ||
		handler.attempts == nil ||
		handler.modelRefreshes == nil ||
		handler.clock == nil {
		writeRelayError(
			response,
			http.StatusServiceUnavailable,
			"relay_unavailable",
			"Claude Native Relay 当前不可用",
		)
		return
	}
	source, authorized := handler.resolveAccountSource(request)
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
	body, modelID, stream, err := readNativeRequest(request)
	if err != nil {
		writeRelayError(
			response,
			http.StatusBadRequest,
			"invalid_relay_request",
			"Claude Relay 请求无效",
		)
		return
	}
	// 订阅额度按 Claude Code 客户端判定，缺身份的请求会被上游按限流拒绝。
	//
	// 但补齐只对**非原生客户端**做：真实 Claude Code 自带身份，对其正文做任何
	// 序列化往返都会改变字段顺序与数值表示，把「透传」偷换成「重建」——那正是
	// Relay 存在的意义所在。
	if !hasNativeClaudeHeaders(request.Header) {
		body = ensureOfficialIdentityBody(body)
	}
	cursor, err := source.Accounts(request.Context(), modelID)
	if err != nil || cursor == nil {
		writeRelayError(
			response,
			http.StatusServiceUnavailable,
			"relay_account_unavailable",
			"Claude Relay 账号当前不可用",
		)
		return
	}

	// 尝试循环：只要客户端还没收到任何字节，可重试失败就换号重发。
	//
	// 每次只保留最新一次结果，被取代的上游连接立即关闭；耗尽时把最后一次真实
	// 上游响应原样交付，绝不合成网关自有错误——把真实 429/529 洗成 502 会让
	// 客户端按「网关故障」立即重试，与限流要求的退避语义相反。
	outcome := attemptOutcome{}
	attempted := false
	for range maxRelayAttempts {
		accountRef, found, nextErr := cursor.Next(request.Context())
		if nextErr != nil || !found {
			break
		}
		attempted = true
		next, retry := handler.attemptRelay(request, accountRef, modelID, body)
		outcome.closeResponse()
		outcome = next
		if !retry {
			break
		}
	}
	if outcome.response == nil {
		failure := outcome.failure
		if !failure.hasFailure() {
			failure = relayFailure{
				status:  http.StatusServiceUnavailable,
				code:    "relay_account_unavailable",
				message: "Claude Relay 账号当前不可用",
			}
		}
		if attempted && outcome.retryAccount {
			response.Header().Set(
				gatewaycontract.RetryAccountHeader,
				gatewaycontract.RetryAccountValue,
			)
		}
		writeRelayError(response, failure.status, failure.code, failure.message)
		return
	}
	upstreamResponse := outcome.response
	route := outcome.route
	defer upstreamResponse.Body.Close()
	retryAccount := outcome.retryAccount

	// Native SSE 可能跨越 Host 默认写超时；只为当前已鉴权 Relay 请求延长。
	_ = http.NewResponseController(response).SetWriteDeadline(
		time.Now().Add(maxRelayDuration),
	)
	copyResponseHeaders(response.Header(), upstreamResponse.Header)
	if retryAccount {
		// 内部换号标记只能由当前 Server 分类生成，不能信任上游同名 Header。
		response.Header().Set(
			gatewaycontract.RetryAccountHeader,
			gatewaycontract.RetryAccountValue,
		)
	}
	response.WriteHeader(upstreamResponse.StatusCode)
	copyResult := responseCopyResult{}
	streamObservation := nativeStreamObservation{}
	if shouldObserveNativeStream(upstreamResponse.Header, stream) &&
		upstreamResponse.StatusCode >= http.StatusOK &&
		upstreamResponse.StatusCode < http.StatusMultipleChoices {
		copyResult, streamObservation = copyAndObserveNativeStream(
			response,
			upstreamResponse.Body,
			upstreamResponse.Header,
			handler.clock(),
		)
	} else {
		copyResult = copyResponseBody(response, upstreamResponse.Body)
	}
	if upstreamResponse.StatusCode < http.StatusOK ||
		upstreamResponse.StatusCode >= http.StatusMultipleChoices ||
		copyResult.downstreamErr != nil {
		return
	}
	if streamObservation.failed {
		handler.recordFailure(
			request.Context(),
			route,
			streamObservation.failure,
		)
		return
	}
	if copyResult.upstreamErr != nil && !streamObservation.completed {
		handler.recordIncompleteStreamFailure(
			request.Context(),
			route,
			copyResult.upstreamErr,
		)
		return
	}
	_ = handler.attempts.RecordSuccess(request.Context(), route)
}

// readNativeRequest 有界保存原始 JSON，并只解析顶层真实模型用于租约复核。
func readNativeRequest(
	request *http.Request,
) ([]byte, runtimecore.ModelID, bool, error) {
	if request == nil || request.Body == nil {
		return nil, "", false, ErrUnsupportedCredential
	}
	body, err := io.ReadAll(io.LimitReader(
		request.Body,
		MaxRequestBodyBytes+1,
	))
	_ = request.Body.Close()
	if err != nil || len(body) == 0 || int64(len(body)) > MaxRequestBodyBytes {
		return nil, "", false, ErrUnsupportedCredential
	}
	var envelope struct {
		Model  string `json:"model"`
		Stream bool   `json:"stream"`
	}
	if json.Unmarshal(body, &envelope) != nil {
		return nil, "", false, ErrUnsupportedCredential
	}
	modelID, err := runtimecore.NewModelID(envelope.Model)
	if err != nil {
		return nil, "", false, err
	}
	return body, modelID, envelope.Stream, nil
}

// recordHTTPFailure 保留原始错误正文，同时记录精确账号模型运行态。
func (handler *Handler) recordHTTPFailure(
	ctx context.Context,
	route runtimecore.ModelRoute,
	response *http.Response,
) bool {
	if ctx == nil || response == nil || response.Body == nil {
		return false
	}
	originalBody := response.Body
	var captured bytes.Buffer
	observation := *response
	observation.Body = io.NopCloser(io.TeeReader(originalBody, &captured))
	classification, err := claudefailure.ObserveHTTP(
		&observation,
		handler.clock(),
	)
	response.Body = &replayReadCloser{
		Reader: io.MultiReader(bytes.NewReader(captured.Bytes()), originalBody),
		Closer: originalBody,
	}
	if err != nil {
		return false
	}
	failure, err := attemptfailure.New(classification)
	if err != nil {
		return false
	}
	return handler.recordFailure(ctx, route, failure)
}

// recordTransportFailure 使用稳定 Go 错误身份记录尚未收到响应的失败。
func (handler *Handler) recordTransportFailure(
	ctx context.Context,
	route runtimecore.ModelRoute,
	err error,
) bool {
	failure, classifyErr := attemptfailure.NewTransport(err)
	if classifyErr != nil {
		return false
	}
	return handler.recordFailure(ctx, route, failure)
}

// recordIncompleteStreamFailure 记录上游在完成事件前断开的流。
func (handler *Handler) recordIncompleteStreamFailure(
	ctx context.Context,
	route runtimecore.ModelRoute,
	err error,
) {
	failure, classifyErr := attemptfailure.NewIncompleteStream(err)
	if classifyErr == nil {
		handler.recordFailure(ctx, route, failure)
	}
}

// recordFailure 统一提交运行态，并在模型不支持时旁路刷新模型目录。
func (handler *Handler) recordFailure(
	ctx context.Context,
	route runtimecore.ModelRoute,
	failure inferencegateway.AttemptFailure,
) bool {
	if !failure.IsValid() ||
		handler.attempts.RecordFailure(ctx, route, failure) != nil {
		return false
	}
	if failure.RuntimeKind() == runtimecore.FailureModelUnsupported {
		_ = handler.modelRefreshes.ScheduleModelRefresh(
			ctx,
			route.AccountRef(),
			claudeauth.ProviderID,
		)
	}
	return failure.ResponseFailure().Retryable()
}

// replayReadCloser 先回放 Observer 已读取的前缀，再继续读取原始响应。
type replayReadCloser struct {
	io.Reader
	io.Closer
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

// closeUpstreamResponse 关闭错误路径中非空的上游响应。
func closeUpstreamResponse(response *http.Response) {
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
}
