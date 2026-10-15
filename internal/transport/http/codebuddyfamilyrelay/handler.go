package codebuddyfamilyrelay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/textproto"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/attemptfailure"
	familyfailure "github.com/madou1217/ai_home/internal/adapters/codebuddyfamily/upstreamfailure"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
	gatewaycontract "github.com/madou1217/ai_home/internal/contracts/claudegateway"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

const (
	// Path 与客户端 chat completions 入口一致（本通道挂在同一路径上）。
	Path = "/v1/chat/completions"
	// MaxRequestBodyBytes 与 Node 宿主默认上限一致（附件历史会放大请求体）。
	MaxRequestBodyBytes int64 = 32 * 1024 * 1024
	// maxRelayAttempts 与 Canonical 编排的上游尝试上限保持一致：账号池很大时不设上限
	// 会让单个请求长时间打转，客户端只观察到超时。
	maxRelayAttempts = 4
	// DegradationHeader 把「本次改写丢了什么信息」告诉客户端（与 Node 侧同名同语义）。
	//
	// 日志里有注解不等于客户端知道；这个头是客户端侧唯一能看见有损的地方。
	DegradationHeader = "x-aih-degradations"
)

// ErrInvalidDependencies 表示 Handler 缺少任一必需端口。
var ErrInvalidDependencies = errors.New("家族透传依赖无效")

// AccountSource 按模型产出候选账号（透传同样需要多账号故障转移）。
type AccountSource interface {
	Accounts(ctx context.Context, modelID runtimecore.ModelID) (AccountCursor, error)
}

// AccountCursor 按调度顺序逐个产出账号，耗尽时返回 false。
type AccountCursor interface {
	Next(ctx context.Context) (accountcore.AccountRef, bool, error)
}

// CredentialResolver 延迟读取并刷新目标账号凭据。
type CredentialResolver interface {
	ResolveObservedCredentialBinding(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountapp.CredentialBinding, accountcredentials.CredentialObservation, error)
	inferencegateway.CredentialObservationVerifier
}

// HTTPClient 是 Relay 发起单个上游请求所需的最小端口。
type HTTPClient interface {
	Do(request *http.Request) (*http.Response, error)
}

// Dependencies 集中声明家族透传的账号、凭据、传输与运行态端口。
type Dependencies struct {
	// Accounts 按调度顺序提供账号；为空表示只服务钉选调用方。
	Accounts AccountSource
	// Fallback 承接透传服务不了的请求，通常是 Canonical 推理入口。
	Fallback http.Handler
	// Credentials 读取目标账号凭据。
	Credentials CredentialResolver
	// Client 发起上游请求。
	Client HTTPClient
	// Attempts 记录运行态（成功与失败都要记，否则 Go 承接的请求在仪表盘上会消失）。
	Attempts inferencegateway.AttemptRecorder
	// Clock 提供时间（可注入，便于测试）。
	Clock func() time.Time
	// DefaultSystemPrompt 覆盖补位文案；为空时用 DefaultSystemPrompt。
	DefaultSystemPrompt string
	// Endpoint 覆盖上游 URL 解析（默认 InferenceEndpoint：站点根 + /v2/chat/completions）。
	//
	// 注入点是给测试与运维用的：测试指向本地假上游；运维若要改址，只改这一处即可，
	// 不必碰常量表。
	Endpoint func(provider string) (string, bool)
}

// Handler 编排账号选择、请求改写、上游透传与响应回写。
type Handler struct {
	accounts     AccountSource
	fallback     http.Handler
	credentials  CredentialResolver
	client       HTTPClient
	attempts     *inferencegateway.ObservedAttemptRecorder
	clock        func() time.Time
	systemPrompt string
	endpoint     func(provider string) (string, bool)
}

// NewHandler 创建默认失败关闭的家族透传通道。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Credentials == nil ||
		dependencies.Client == nil ||
		dependencies.Attempts == nil ||
		dependencies.Clock == nil {
		return nil, ErrInvalidDependencies
	}
	attempts, err := inferencegateway.NewObservedAttemptRecorder(
		dependencies.Attempts,
		dependencies.Credentials,
	)
	if err != nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		accounts:     dependencies.Accounts,
		fallback:     dependencies.Fallback,
		credentials:  dependencies.Credentials,
		client:       dependencies.Client,
		attempts:     attempts,
		clock:        dependencies.Clock,
		systemPrompt: strings.TrimSpace(dependencies.DefaultSystemPrompt),
		endpoint:     resolveEndpoint(dependencies.Endpoint),
	}, nil
}

// resolveEndpoint 取注入的端点解析器；未注入时用包内默认（站点根 + /v2/chat/completions）。
func resolveEndpoint(injected func(provider string) (string, bool)) func(string) (string, bool) {
	if injected != nil {
		return injected
	}
	return InferenceEndpoint
}

// attemptOutcome 描述一次上游尝试对编排的影响。
type attemptOutcome struct {
	// response 是尚未写给客户端的上游响应，可能为空（未触网或凭据不可用）。
	response *http.Response
	// route 是本次尝试的账号模型元组，用于运行态记账。
	route runtimecore.ModelRoute
	// observation 是本次尝试读取凭据时看到的低敏持久化观察。
	observation accountcredentials.CredentialObservation
	// rewritten 是本次尝试真正发出去的请求体改写结论（用于降级头与日志）。
	rewritten RewriteResult
	// provider 是本次尝试实际使用的家族 Provider（用于服务归属响应头）。
	provider string
	// credentialUnfit 表示账号凭据无法由透传承载（非家族原生凭据）。
	credentialUnfit bool
	// retryAccount 表示该失败可以换账号重试。
	retryAccount bool
	// failure 描述没有上游响应时该如何回复客户端。
	failure relayFailure
}

// relayFailure 是没有上游响应可交付时的网关自有错误。
type relayFailure struct {
	status  int
	code    string
	message string
}

// closeResponse 释放该结果持有的上游连接。
func (outcome attemptOutcome) closeResponse() {
	closeUpstreamResponse(outcome.response)
}

// ServeHTTP 在触网前完成 HTTP 合同检查与账号来源解析。
//
// 与 Canonical 的关系：任何「本通道表达不了」的请求都交回 Canonical，而不是在这里拒绝
// ——跨协议/非家族模型的请求本来就该由它承载，透传只承诺处理家族官方端点这一种形态。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil ||
		handler.credentials == nil ||
		handler.client == nil ||
		handler.attempts == nil ||
		handler.clock == nil {
		writeRelayError(
			response,
			http.StatusServiceUnavailable,
			"relay_unavailable",
			"家族透传当前不可用",
		)
		return
	}
	if !relayContractSatisfied(request) {
		handler.delegate(response, request, nil)
		return
	}
	// 正文先读全：既要改写，也可能在交还时原样重放（不能只读一次）。
	body, readErr := io.ReadAll(io.LimitReader(request.Body, MaxRequestBodyBytes+1))
	request.Body = io.NopCloser(bytes.NewReader(body))
	request.ContentLength = int64(len(body))
	if readErr != nil || int64(len(body)) > MaxRequestBodyBytes {
		handler.delegate(response, request, body)
		return
	}
	modelID, stream, ok := readFamilyRequest(body)
	if !ok {
		handler.delegate(response, request, body)
		return
	}
	source := handler.resolveAccountSource(request)
	if source == nil {
		handler.delegate(response, request, body)
		return
	}
	cursor, err := source.Accounts(request.Context(), modelID)
	if err != nil || cursor == nil {
		// 该模型没有可透传的家族账号（例如它只由别的 Provider 提供）：交回 Canonical 选路。
		handler.delegate(response, request, body)
		return
	}

	// 尝试循环：只要客户端还没收到任何字节，可重试失败就换号重发；耗尽时交付最后一次
	// 真实上游响应，绝不把真实 429/5xx 洗成网关自有错误（那会让客户端按「网关故障」
	// 立即重试，与限流要求的退避语义相反）。
	outcome := attemptOutcome{}
	attempted := false
	for range maxRelayAttempts {
		accountRef, found, nextErr := cursor.Next(request.Context())
		if nextErr != nil || !found {
			break
		}
		attempted = true
		next, retry := handler.attemptRelay(request, accountRef, modelID, body, stream)
		outcome.closeResponse()
		outcome = next
		if !retry {
			break
		}
	}
	if outcome.response == nil {
		if !attempted {
			handler.delegate(response, request, body)
			return
		}
		failure := outcome.failure
		if failure.status == 0 {
			failure = relayFailure{
				status:  http.StatusServiceUnavailable,
				code:    "relay_account_unavailable",
				message: "家族透传账号当前不可用",
			}
		}
		if outcome.retryAccount {
			// 内部换号标记只能由当前 Server 生成，不能信任上游同名 Header。
			response.Header().Set(gatewaycontract.RetryAccountHeader, gatewaycontract.RetryAccountValue)
		}
		writeRelayError(response, failure.status, failure.code, failure.message)
		return
	}
	handler.writeResponse(response, request, outcome, stream)
}

// readFamilyRequest 读取模型与客户端是否要流式；返回 false 表示交回 Canonical。
func readFamilyRequest(body []byte) (runtimecore.ModelID, bool, bool) {
	fields, ok := decodeRawObject(body)
	if !ok {
		return "", false, false
	}
	model, ok := rawString(fields["model"])
	if !ok {
		return "", false, false
	}
	modelID, err := runtimecore.NewModelID(strings.TrimSpace(model))
	if err != nil {
		return "", false, false
	}
	stream := false
	if raw, ok := fields["stream"]; ok {
		if value, ok := rawBool(raw); ok {
			stream = value
		}
	}
	return modelID, stream, true
}

// relayContractSatisfied 静默判断请求能否走透传（不写响应）。
//
// 不满足时交回 Canonical 而不是报错：调用方可能压根没打算用透传。
func relayContractSatisfied(request *http.Request) bool {
	if request == nil || request.URL == nil || request.URL.Path != Path {
		return false
	}
	if request.Method != http.MethodPost {
		return false
	}
	if request.Body == nil || request.ContentLength <= 0 || request.ContentLength > MaxRequestBodyBytes {
		return false
	}
	mediaType := strings.TrimSpace(request.Header.Get("Content-Type"))
	return mediaType == "" || strings.HasPrefix(mediaType, "application/json")
}

// delegate 把请求交给 Canonical 入口，并恢复可能已被读走的正文。
func (handler *Handler) delegate(response http.ResponseWriter, request *http.Request, body []byte) {
	if handler.fallback == nil {
		writeRelayError(
			response,
			http.StatusServiceUnavailable,
			"relay_unavailable",
			"家族透传当前不可用",
		)
		return
	}
	if body != nil {
		request.Body = io.NopCloser(bytes.NewReader(body))
		request.ContentLength = int64(len(body))
	}
	handler.fallback.ServeHTTP(response, request)
}

// writeRelayError 写网关自有错误（OpenAI 错误体形态，与客户端协议一致）。
func writeRelayError(response http.ResponseWriter, status int, code string, message string) {
	payload, err := json.Marshal(map[string]any{
		"error": map[string]string{"type": code, "code": code, "message": message},
	})
	if err != nil {
		payload = []byte(`{"error":{"type":"relay_error","message":"relay error"}}`)
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_, _ = response.Write(payload)
}

// closeUpstreamResponse 关闭上游响应体（允许 nil）。
func closeUpstreamResponse(response *http.Response) {
	if response == nil || response.Body == nil {
		return
	}
	_ = response.Body.Close()
}

// rawBool 只接受 JSON 布尔。
func rawBool(raw json.RawMessage) (bool, bool) {
	trimmed := strings.TrimSpace(string(raw))
	switch trimmed {
	case "true":
		return true, true
	case "false":
		return false, true
	default:
		return false, false
	}
}

// errNoRelayAccount 表示当前请求没有可透传的家族账号。
var errNoRelayAccount = errors.New("没有可用于家族透传的账号")

// resolveAccountSource 决定本次请求的账号来源。
//
// 钉选（x-account-ref）只能使用该账号：调度器会按模型另挑家族账号，把钉到别的 Provider
// 的请求静默改派。非法钉选交回 Canonical，由它按协议返回 400。
func (handler *Handler) resolveAccountSource(request *http.Request) AccountSource {
	values := request.Header.Values(inferenceapi.AccountRefHeader)
	if len(values) == 0 {
		return handler.accounts
	}
	if len(values) != 1 {
		return nil
	}
	accountRef, err := accountcore.ParseAccountRef(strings.TrimSpace(values[0]))
	if err != nil {
		return nil
	}
	return pinnedAccountSource{handler: handler, accountRef: accountRef}
}

// pinnedAccountSource 只在钉选账号本身是家族账号时透传；否则报告无可用账号，
// 让调用方交回 Canonical（Canonical 同样按钉选只用该账号）。
type pinnedAccountSource struct {
	handler    *Handler
	accountRef accountcore.AccountRef
}

func (source pinnedAccountSource) Accounts(
	ctx context.Context,
	_ runtimecore.ModelID,
) (AccountCursor, error) {
	if source.handler == nil || source.handler.credentials == nil || !source.accountRef.IsValid() {
		return nil, errNoRelayAccount
	}
	binding, _, err := source.handler.credentials.ResolveObservedCredentialBinding(ctx, source.accountRef)
	if err != nil || !binding.IsValid() || !IsFamilyProvider(binding.ProviderID()) {
		return nil, errNoRelayAccount
	}
	return &singleAccountCursor{accountRef: source.accountRef}, nil
}

// singleAccountCursor 只产出一个账号，之后即耗尽。
type singleAccountCursor struct {
	accountRef accountcore.AccountRef
	consumed   bool
}

func (cursor *singleAccountCursor) Next(_ context.Context) (accountcore.AccountRef, bool, error) {
	if cursor == nil || cursor.consumed {
		return "", false, nil
	}
	cursor.consumed = true
	return cursor.accountRef, true, nil
}

// attemptRelay 用指定账号执行一次上游透传尝试。
//
// 关键约束：本函数**不向客户端写任何字节**——轮转只有在客户端尚未收到任何输出时才安全。
func (handler *Handler) attemptRelay(
	request *http.Request,
	accountRef accountcore.AccountRef,
	modelID runtimecore.ModelID,
	body []byte,
	stream bool,
) (attemptOutcome, bool) {
	route, err := runtimecore.NewModelRoute(accountRef, modelID.String())
	if err != nil {
		return attemptOutcome{failure: relayFailure{
			status:  http.StatusBadGateway,
			code:    "relay_state_unavailable",
			message: "家族透传运行态不可用",
		}}, false
	}
	binding, observation, err := handler.credentials.ResolveObservedCredentialBinding(
		request.Context(),
		accountRef,
	)
	if err != nil ||
		!binding.IsValid() ||
		binding.AccountRef() != accountRef ||
		!observation.IsValid() ||
		observation.AccountRef() != accountRef ||
		!IsFamilyProvider(binding.ProviderID()) {
		// 凭据读取失败属该账号自身问题，换号可能成功。
		return attemptOutcome{
			route:        route,
			retryAccount: true,
			failure: relayFailure{
				status:  http.StatusServiceUnavailable,
				code:    "relay_account_unavailable",
				message: "家族透传账号当前不可用",
			},
		}, true
	}
	provider := binding.ProviderID()
	accessToken, err := AccessTokenFromCredential(binding.Credential())
	if err != nil {
		// 凭据不适配是账号的确定性属性：交回 Canonical（它尊重账号自带差异），**不换号**
		// ——因凭据不适配就跳到下一个，会让透传系统性偏向某类账号，公平轮转失效。
		return attemptOutcome{
			route:           route,
			credentialUnfit: true,
			failure: relayFailure{
				status:  http.StatusUnprocessableEntity,
				code:    "unsupported_relay_credential",
				message: "家族透传账号必须使用原生登录态",
			},
		}, false
	}
	rewritten, err := RewriteRequestBody(body, RewriteOptions{DefaultSystemPrompt: handler.systemPrompt})
	if err != nil {
		// 请求体本端表达不了：交回 Canonical 按客户端协议给规范错误。
		return attemptOutcome{
			route:           route,
			credentialUnfit: true,
			failure: relayFailure{
				status:  http.StatusBadRequest,
				code:    "invalid_relay_request",
				message: "家族透传请求无效",
			},
		}, false
	}
	endpoint, ok := handler.endpoint(provider)
	if !ok {
		return attemptOutcome{
			route:           route,
			credentialUnfit: true,
			failure: relayFailure{
				status:  http.StatusUnprocessableEntity,
				code:    "unsupported_relay_credential",
				message: "家族透传账号必须使用原生登录态",
			},
		}, false
	}
	upstream, err := http.NewRequestWithContext(
		request.Context(),
		http.MethodPost,
		endpoint,
		bytes.NewReader(rewritten.Body),
	)
	if err != nil {
		return attemptOutcome{
			route: route,
			failure: relayFailure{
				status:  http.StatusBadRequest,
				code:    "invalid_relay_request",
				message: "家族透传请求无效",
			},
		}, false
	}
	applyFamilyUpstreamHeaders(upstream, provider, accessToken)
	upstreamResponse, err := handler.client.Do(upstream)
	if err != nil || upstreamResponse == nil || upstreamResponse.Body == nil {
		closeUpstreamResponse(upstreamResponse)
		retry := err != nil && handler.recordTransportFailure(request.Context(), route, observation, err)
		return attemptOutcome{
			route:        route,
			retryAccount: retry,
			failure: relayFailure{
				status:  http.StatusBadGateway,
				code:    "relay_upstream_unavailable",
				message: "家族上游暂时不可用",
			},
		}, retry
	}
	if upstreamResponse.StatusCode >= http.StatusOK &&
		upstreamResponse.StatusCode < http.StatusMultipleChoices {
		// 成功也要记账：否则运行态与仪表盘看不到这个账号在工作。
		handler.recordSuccess(request.Context(), route, observation)
		return attemptOutcome{
			response:    upstreamResponse,
			route:       route,
			observation: observation,
			rewritten:   rewritten,
			provider:    provider,
		}, false
	}
	retry := handler.recordHTTPFailure(request.Context(), route, observation, upstreamResponse)
	return attemptOutcome{
		response:     upstreamResponse,
		route:        route,
		observation:  observation,
		rewritten:    rewritten,
		provider:     provider,
		retryAccount: retry,
	}, retry
}

// applyFamilyUpstreamHeaders 补齐家族上游要求的外层标识（约束 4 与站点来源）。
func applyFamilyUpstreamHeaders(upstream *http.Request, provider string, accessToken string) {
	upstream.Header.Set("Content-Type", "application/json")
	upstream.Header.Set("Accept", "text/event-stream")
	upstream.Header.Set("Authorization", "Bearer "+accessToken)
	upstream.Header.Set("User-Agent", UserAgent)
	upstream.Header.Set("X-Requested-With", "XMLHttpRequest")
	if base, ok := InferenceBaseURL(provider); ok {
		upstream.Header.Set("Origin", base)
		upstream.Header.Set("Referer", base+"/")
	}
}

// writeResponse 把上游响应交付给客户端。
//
// 客户端要非流式而上游只给流（约束 2）时在这里聚合；流式则逐字节透传并逐事件刷新
// ——上游的富字段（reasoning_content / function_call / extra_fields）因此原样保留。
func (handler *Handler) writeResponse(
	response http.ResponseWriter,
	request *http.Request,
	outcome attemptOutcome,
	stream bool,
) {
	upstreamResponse := outcome.response
	defer upstreamResponse.Body.Close()
	copyResponseHeaders(response.Header(), upstreamResponse.Header)
	if outcome.retryAccount {
		response.Header().Set(gatewaycontract.RetryAccountHeader, gatewaycontract.RetryAccountValue)
	}
	// 与 Node 宿主及 Canonical 推理路径一致：声明实际服务的账号（覆盖上游同名 Header）。
	response.Header().Set(inferenceapi.ServedAccountRefHeader, outcome.route.AccountRef().String())
	response.Header().Set(inferenceapi.ServedProviderHeader, outcome.provider)
	// 有损改写必须让客户端看得见：日志里有注解，但客户端不读日志。
	if len(outcome.rewritten.Degradations) > 0 {
		response.Header().Set(DegradationHeader, strings.Join(outcome.rewritten.Degradations, ","))
	}
	// 只有「客户端要非流式」且「上游是成功响应」才聚合。
	//
	// 上游错误响应绝不能进聚合器：那是一段 JSON 错误正文，按 SSE 解析会产出空的
	// chat.completion —— 等于把真实的 403/429 洗成「模型没说话」，客户端既看不到原因
	// 也拿不到可重试信号。错误响应与流式客户端一律逐字节交付上游原文。
	if !stream &&
		upstreamResponse.StatusCode >= http.StatusOK &&
		upstreamResponse.StatusCode < http.StatusMultipleChoices {
		payload, err := io.ReadAll(io.LimitReader(upstreamResponse.Body, MaxRequestBodyBytes+1))
		if err != nil {
			writeRelayError(response, http.StatusBadGateway, "relay_upstream_unavailable", "家族上游响应读取失败")
			return
		}
		aggregated := AggregateSSE(payload, handler.clock)
		if len(aggregated.Payload) == 0 {
			writeRelayError(response, http.StatusBadGateway, "relay_upstream_unavailable", "家族上游响应为空")
			return
		}
		response.Header().Del("Content-Length")
		response.Header().Set("Content-Type", "application/json; charset=utf-8")
		response.WriteHeader(upstreamResponse.StatusCode)
		_, _ = response.Write(aggregated.Payload)
		return
	}
	if upstreamResponse.StatusCode >= http.StatusOK &&
		upstreamResponse.StatusCode < http.StatusMultipleChoices {
		response.Header().Set("Cache-Control", "no-cache")
		response.Header().Set("X-Accel-Buffering", "no")
		response.Header().Set("X-Content-Type-Options", "nosniff")
	}
	response.WriteHeader(upstreamResponse.StatusCode)
	_ = copyStreaming(response, upstreamResponse.Body)
}

// recordSuccess 记录一次成功尝试（成功也要记，否则运行态看不到账号在工作）。
func (handler *Handler) recordSuccess(
	ctx context.Context,
	route runtimecore.ModelRoute,
	observation accountcredentials.CredentialObservation,
) bool {
	success, err := inferencegateway.NewAttemptSuccess(handler.clock())
	if err != nil {
		return false
	}
	recorded, err := handler.attempts.RecordSuccess(ctx, route, observation, success)
	return err == nil && recorded
}

// recordTransportFailure 记录传输层失败（未拿到上游响应）。
func (handler *Handler) recordTransportFailure(
	ctx context.Context,
	route runtimecore.ModelRoute,
	observation accountcredentials.CredentialObservation,
	transportErr error,
) bool {
	classification, err := sharedfailure.ClassifyTransportError(transportErr)
	if err != nil {
		return false
	}
	return handler.recordClassification(ctx, route, observation, classification)
}

// recordHTTPFailure 记录上游 HTTP 失败，并返回「是否值得换号重试」。
//
// 观察器必须看到原始正文：按上限预读一次，再用 MultiReader 把同样的字节交付给调用方。
func (handler *Handler) recordHTTPFailure(
	ctx context.Context,
	route runtimecore.ModelRoute,
	observation accountcredentials.CredentialObservation,
	response *http.Response,
) bool {
	if response == nil || response.Body == nil {
		return false
	}
	originalBody := response.Body
	prefix, readErr := io.ReadAll(io.LimitReader(originalBody, sharedfailure.MaxErrorPayloadBytes+1))
	if readErr != nil {
		return false
	}
	response.Body = &replayReadCloser{
		Reader: io.MultiReader(bytes.NewReader(prefix), originalBody),
		Closer: originalBody,
	}
	classification, err := familyfailure.ObserveHTTP(
		response.StatusCode,
		response.Header,
		prefix,
		handler.clock(),
	)
	if err != nil {
		// 没有失败证据（例如 2xx）或分类不可用：不换号，按上游原样交付。
		return false
	}
	return handler.recordClassification(ctx, route, observation, classification)
}

// recordClassification 写入运行态并给出换号建议。
func (handler *Handler) recordClassification(
	ctx context.Context,
	route runtimecore.ModelRoute,
	observation accountcredentials.CredentialObservation,
	classification sharedfailure.Classification,
) bool {
	failure, err := attemptfailure.New(classification)
	if err != nil {
		return false
	}
	recorded, err := handler.attempts.RecordFailure(ctx, route, observation, failure)
	if err != nil {
		return false
	}
	_ = recorded
	return retryableKind(classification.Kind())
}

// retryableKind 判断该失败是否值得换账号重试。
//
// 显式列出而不是从策略反推：换号只在「换一个账号可能就好」时才安全；账号自身的问题
// （凭据被拒、权限不足、请求不合法）换号只是把同一个失败重复几次。
func retryableKind(kind runtimecore.FailureKind) bool {
	switch kind {
	case runtimecore.FailureRateLimited,
		runtimecore.FailureUpstreamUnavailable,
		runtimecore.FailureRequestTimeout:
		return true
	default:
		return false
	}
}

// copyResponseHeaders 复制上游响应头，去掉逐跳与长度字段（长度由本端决定）。
func copyResponseHeaders(destination, source http.Header) {
	for name, values := range source {
		canonical := textproto.CanonicalMIMEHeaderKey(name)
		if hopByHopResponseHeaders[canonical] {
			continue
		}
		for _, value := range values {
			destination.Add(canonical, value)
		}
	}
}

// copyStreaming 逐块回写并刷新，保证 SSE 事件按到达顺序即时可见。
func copyStreaming(destination http.ResponseWriter, source io.Reader) error {
	buffer := make([]byte, 32*1024)
	for {
		read, readErr := source.Read(buffer)
		if read > 0 {
			if _, writeErr := destination.Write(buffer[:read]); writeErr != nil {
				return writeErr
			}
			if flusher, ok := destination.(http.Flusher); ok {
				flusher.Flush()
			}
		}
		if readErr == io.EOF {
			return nil
		}
		if readErr != nil {
			return readErr
		}
	}
}

// hopByHopResponseHeaders 是不得跨网关转发的响应头。
var hopByHopResponseHeaders = map[string]bool{
	"Connection":          true,
	"Keep-Alive":          true,
	"Proxy-Authenticate":  true,
	"Proxy-Authorization": true,
	"Proxy-Connection":    true,
	"Te":                  true,
	"Trailer":             true,
	"Transfer-Encoding":   true,
	"Upgrade":             true,
	"Content-Length":      true,
}

// replayReadCloser 让预读过的正文可以再被完整读取。
type replayReadCloser struct {
	io.Reader
	io.Closer
}
