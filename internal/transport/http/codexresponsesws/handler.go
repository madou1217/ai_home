// Package codexresponsesws 提供 /v1/responses 的原生 WebSocket 入站传输。
//
// 客户端帧除最小路由观察外保持原样；账号选择、上游认证和运行态提交分别委托
// 给应用层与 Provider 适配器。
package codexresponsesws

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/codexwebsocket"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/attemptfailure"
	"github.com/madou1217/ai_home/internal/adapters/codex/responseswebsocket"
	codexfailure "github.com/madou1217/ai_home/internal/adapters/codex/upstreamfailure"
)

const (
	// Path 与 HTTP Responses API 共用，是否 Upgrade 由 Host Dispatcher 决定。
	Path = "/v1/responses"
	// MaxMessageBytes 限制单个解压后业务消息占用。
	MaxMessageBytes     int64 = 16 * 1024 * 1024
	firstFrameTimeout         = 30 * time.Second
	upstreamDialTimeout       = 15 * time.Second
	writeTimeout              = 30 * time.Second
)

var (
	// ErrInvalidDependencies 表示 Handler 缺少鉴权、选择、上游或运行态端口。
	ErrInvalidDependencies = errors.New("Codex Responses WebSocket Handler 依赖无效")
	// ErrInvalidClientFrame 表示客户端帧不满足 response.create 合同。
	ErrInvalidClientFrame = errors.New("Codex Responses WebSocket 客户端帧无效")
	// ErrConcurrentTurn 表示同一连接在前一轮终态前又提交了新请求。
	ErrConcurrentTurn = errors.New("Codex Responses WebSocket 只允许串行请求")
)

// Authorizer 是标准推理客户端密钥的最小鉴权端口。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Selector 在读取首帧模型后选择连接级固定账号。
type Selector interface {
	Select(
		ctx context.Context,
		request codexwebsocket.Request,
	) (codexwebsocket.Selection, error)
}

// UpstreamDialer 使用选择结果中的临时凭据连接 Codex WS。
type UpstreamDialer interface {
	Connect(
		ctx context.Context,
		credential accountapp.Credential,
		clientHeader http.Header,
		localAuthority string,
	) (responseswebsocket.Connection, *http.Response, error)
}

// Dependencies 声明原生 WS Handler 的稳定外部端口。
type Dependencies struct {
	Authorizer Authorizer
	Selector   Selector
	Upstream   UpstreamDialer
	Attempts   inferencegateway.AttemptRecorder
	// CredentialObservations 在终态写运行态前复核连接所用凭据是否仍是当前快照。
	CredentialObservations inferencegateway.CredentialObservationVerifier
	ModelRefreshes         inferencegateway.ModelRefreshScheduler
	Clock                  func() time.Time
}

// Handler 管理 Upgrade、连接注册、双向帧代理和终态观察。
type Handler struct {
	authorizer     Authorizer
	selector       Selector
	upstream       UpstreamDialer
	attempts       *inferencegateway.ObservedAttemptRecorder
	modelRefreshes inferencegateway.ModelRefreshScheduler
	clock          func() time.Time
	sessions       *sessionRegistry
}

// NewHandler 创建支持并发连接且可显式关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil ||
		dependencies.Selector == nil ||
		dependencies.Upstream == nil ||
		dependencies.Attempts == nil ||
		dependencies.CredentialObservations == nil ||
		dependencies.ModelRefreshes == nil ||
		dependencies.Clock == nil {
		return nil, ErrInvalidDependencies
	}
	attempts, err := inferencegateway.NewObservedAttemptRecorder(
		dependencies.Attempts,
		dependencies.CredentialObservations,
	)
	if err != nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer:     dependencies.Authorizer,
		selector:       dependencies.Selector,
		upstream:       dependencies.Upstream,
		attempts:       attempts,
		modelRefreshes: dependencies.ModelRefreshes,
		clock:          dependencies.Clock,
		sessions:       newSessionRegistry(),
	}, nil
}

// Close 关闭所有被 net/http 视为 hijacked 的 WS 连接，并拒绝新连接。
func (handler *Handler) Close() error {
	if handler == nil || handler.sessions == nil {
		return nil
	}
	return handler.sessions.Close()
}

// ServeHTTP 在触网和读取数据库凭据前完成客户端鉴权与 Origin 校验。
func (handler *Handler) ServeHTTP(
	response http.ResponseWriter,
	request *http.Request,
) {
	if !handler.available() {
		writeHTTPError(
			response,
			http.StatusServiceUnavailable,
			"websocket_unavailable",
			"Codex Responses WebSocket 当前不可用",
		)
		return
	}
	if len(request.Header.Values(responseswebsocket.HopHeader)) > 0 {
		writeHTTPError(
			response,
			http.StatusLoopDetected,
			"websocket_proxy_loop",
			"检测到 Codex Responses WebSocket 代理自循环",
		)
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeHTTPError(
			response,
			http.StatusUnauthorized,
			"unauthorized",
			"需要有效的客户端密钥",
		)
		return
	}
	// HTTP Server 的普通请求 deadline 不适用于可跨多轮复用的 WS。Upgrade 前
	// 显式清除底层连接 deadline，后续首帧、建连和每次写入仍由独立 context 有界。
	controller := http.NewResponseController(response)
	_ = controller.SetReadDeadline(time.Time{})
	_ = controller.SetWriteDeadline(time.Time{})
	client, err := websocket.Accept(
		response,
		request,
		&websocket.AcceptOptions{
			CompressionMode: websocket.CompressionContextTakeover,
		},
	)
	if err != nil {
		return
	}
	client.SetReadLimit(MaxMessageBytes)
	session := newManagedSession(client)
	if !handler.sessions.Add(session) {
		_ = client.Close(websocket.StatusServiceRestart, "server closing")
		return
	}
	defer handler.sessions.Remove(session)
	defer session.CloseNow()

	firstFrameCtx, cancelFirstFrame := context.WithTimeout(
		session.Context(),
		firstFrameTimeout,
	)
	messageType, firstFrame, err := client.Read(firstFrameCtx)
	cancelFirstFrame()
	if err != nil {
		return
	}
	if messageType != websocket.MessageText {
		writeWebSocketError(
			client,
			http.StatusBadRequest,
			"unsupported_frame_type",
			"只支持文本 response.create 帧",
		)
		_ = client.Close(websocket.StatusUnsupportedData, "text frames required")
		return
	}
	firstRequest, err := parseClientFrame(firstFrame)
	if err != nil {
		writeWebSocketError(
			client,
			http.StatusBadRequest,
			"invalid_response_create",
			"首帧必须是有效的 response.create",
		)
		_ = client.Close(websocket.StatusPolicyViolation, "invalid response.create")
		return
	}
	selection, err := handler.selector.Select(
		session.Context(),
		codexwebsocket.Request{
			ClientProtocol: inference.ClientProtocolOpenAIResponses,
			Model:          firstRequest.Model,
		},
	)
	if err != nil {
		handler.writeSelectionError(client, err)
		return
	}
	route, err := runtimecore.NewModelRoute(
		selection.AccountRef(),
		selection.Route().EffectiveModel(),
	)
	if err != nil {
		writeWebSocketError(
			client,
			http.StatusInternalServerError,
			"invalid_runtime_route",
			"账号运行态路由无效",
		)
		return
	}
	observer := newTurnObserver(
		firstRequest.Model,
		route,
		selection.CredentialObservation(),
		handler.attempts,
		handler.modelRefreshes,
		handler.clock,
	)
	if err := observer.Begin(firstFrame); err != nil {
		writeWebSocketError(
			client,
			http.StatusBadRequest,
			"invalid_response_create",
			"首帧必须是有效的 response.create",
		)
		return
	}
	dialCtx, cancelDial := context.WithTimeout(
		session.Context(),
		upstreamDialTimeout,
	)
	upstream, upstreamResponse, dialErr := handler.upstream.Connect(
		dialCtx,
		selection.Credential(),
		request.Header,
		request.Host,
	)
	cancelDial()
	if dialErr != nil {
		handler.handleDialFailure(
			client,
			route,
			selection.CredentialObservation(),
			upstreamResponse,
			dialErr,
		)
		return
	}
	if upstream == nil || !session.SetUpstream(upstream) {
		if upstream != nil {
			_ = upstream.CloseNow()
		}
		return
	}
	upstream.SetReadLimit(MaxMessageBytes)
	if err := writeMessage(
		session.Context(),
		upstream,
		websocket.MessageText,
		firstFrame,
	); err != nil {
		handler.recordTransportFailure(
			route,
			selection.CredentialObservation(),
			err,
		)
		writeWebSocketError(
			client,
			http.StatusBadGateway,
			"upstream_write_failed",
			"Codex WebSocket 上游写入失败",
		)
		return
	}
	handler.proxy(session, observer)
}

// available 防止零值或关闭后的 Handler 接受新连接。
func (handler *Handler) available() bool {
	return handler != nil &&
		handler.authorizer != nil &&
		handler.selector != nil &&
		handler.upstream != nil &&
		handler.attempts != nil &&
		handler.modelRefreshes != nil &&
		handler.clock != nil &&
		handler.sessions != nil &&
		!handler.sessions.Closed()
}

// proxy 同时泵送两个方向；任一方向结束后取消另一个方向并传播关闭语义。
func (handler *Handler) proxy(
	session *managedSession,
	observer *turnObserver,
) {
	results := make(chan pumpResult, 2)
	go pumpClientToUpstream(session, observer, results)
	go pumpUpstreamToClient(session, observer, results)
	result := <-results
	if result.source == pumpSourceUpstream &&
		result.recordIncomplete &&
		!session.Closing() &&
		observer.ActiveGenerating() {
		failure, err := attemptfailure.NewIncompleteStream(result.err)
		if err == nil {
			_ = recordCodexFailure(
				context.Background(),
				handler.attempts,
				handler.modelRefreshes,
				observer.Route(),
				observer.CredentialObservation(),
				failure,
			)
		}
	}
	propagateClose(result, session.Other(result.source))
	session.Cancel()
	<-results
}

// handleDialFailure 把真实握手 HTTP 错误或传输错误提交到统一运行态。
func (handler *Handler) handleDialFailure(
	client responseswebsocket.Connection,
	route runtimecore.ModelRoute,
	observation accountcredentials.CredentialObservation,
	response *http.Response,
	dialErr error,
) {
	if errors.Is(dialErr, responseswebsocket.ErrSelfLoop) ||
		errors.Is(dialErr, responseswebsocket.ErrInvalidEndpoint) ||
		errors.Is(dialErr, responseswebsocket.ErrUnsupportedCredential) {
		writeWebSocketError(
			client,
			http.StatusBadGateway,
			"upstream_websocket_invalid",
			"Codex WebSocket 上游配置无效",
		)
		return
	}
	var failure inferencegateway.AttemptFailure
	var err error
	if response != nil && response.Body != nil {
		classification, observeErr := codexfailure.ObserveHTTP(
			response,
			handler.clock(),
		)
		if observeErr == nil {
			failure, err = attemptfailure.New(classification)
		}
	}
	if !failure.IsValid() {
		failure, err = attemptfailure.NewTransport(dialErr)
	}
	if err == nil && failure.IsValid() {
		_ = recordCodexFailure(
			context.Background(),
			handler.attempts,
			handler.modelRefreshes,
			route,
			observation,
			failure,
		)
		responseFailure := failure.ResponseFailure()
		status := http.StatusBadGateway
		if response != nil &&
			response.StatusCode >= http.StatusBadRequest &&
			response.StatusCode <= 599 {
			status = response.StatusCode
		}
		writeWebSocketError(
			client,
			status,
			responseFailure.Code(),
			responseFailure.SafeMessage(),
		)
		return
	}
	writeWebSocketError(
		client,
		http.StatusBadGateway,
		"upstream_websocket_unavailable",
		"Codex WebSocket 上游连接失败",
	)
}

// recordTransportFailure 在首帧尚未产生上游事件时记录连接写入失败。
func (handler *Handler) recordTransportFailure(
	route runtimecore.ModelRoute,
	observation accountcredentials.CredentialObservation,
	err error,
) {
	failure, classifyErr := attemptfailure.NewTransport(err)
	if classifyErr == nil {
		_ = recordCodexFailure(
			context.Background(),
			handler.attempts,
			handler.modelRefreshes,
			route,
			observation,
			failure,
		)
	}
}

// writeSelectionError 把路由和账号不可用区分为稳定的 WS 内错误。
func (handler *Handler) writeSelectionError(
	client responseswebsocket.Connection,
	err error,
) {
	status := http.StatusServiceUnavailable
	code := "no_available_account"
	message := "当前没有可用的 Codex 账号"
	if errors.Is(err, codexwebsocket.ErrInvalidRequest) ||
		errors.Is(err, codexwebsocket.ErrModelRewriteRequired) {
		status = http.StatusBadRequest
		code = "native_model_not_exact"
		message = "Codex WebSocket 必须使用目录中的精确模型"
	} else if errors.Is(err, inferencegateway.ErrRouteNotFound) {
		status = http.StatusNotFound
		code = "model_not_found"
		message = "当前没有对应的 Codex WebSocket 模型路由"
	}
	writeWebSocketError(client, status, code, message)
}

// parseClientFrame 只观察路由和串行状态所需字段，不拒绝任何未知字段。
func parseClientFrame(payload []byte) (clientRequestEnvelope, error) {
	var request clientRequestEnvelope
	if json.Unmarshal(payload, &request) != nil ||
		request.Type != "response.create" {
		return clientRequestEnvelope{}, ErrInvalidClientFrame
	}
	modelID, err := runtimecore.NewModelID(request.Model)
	if err != nil || modelID.String() != request.Model {
		return clientRequestEnvelope{}, ErrInvalidClientFrame
	}
	return request, nil
}

// clientRequestEnvelope 是 response.create 的有界最小观察投影。
type clientRequestEnvelope struct {
	Type     string `json:"type"`
	Model    string `json:"model"`
	Generate *bool  `json:"generate"`
}

// IsUpgradeRequest 判断 /v1/responses 请求是否明确要求 WebSocket Upgrade。
func IsUpgradeRequest(request *http.Request) bool {
	if request == nil {
		return false
	}
	return headerContainsToken(request.Header, "Connection", "upgrade") &&
		headerContainsToken(request.Header, "Upgrade", "websocket")
}

// headerContainsToken 按 RFC 7230 解析逗号分隔、大小写不敏感的 Header Token。
func headerContainsToken(header http.Header, name string, token string) bool {
	for _, value := range header.Values(name) {
		for candidate := range strings.SplitSeq(value, ",") {
			if strings.EqualFold(strings.TrimSpace(candidate), token) {
				return true
			}
		}
	}
	return false
}

// writeMessage 给每次写入设置独立上限，形成自然背压而不创建无界缓冲。
func writeMessage(
	ctx context.Context,
	connection responseswebsocket.Connection,
	messageType websocket.MessageType,
	payload []byte,
) error {
	writeCtx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return connection.Write(writeCtx, messageType, payload)
}

// writeWebSocketError 写入不包含 Provider 原文的稳定错误帧。
func writeWebSocketError(
	connection responseswebsocket.Connection,
	status int,
	code string,
	message string,
) {
	payload, err := json.Marshal(webSocketErrorEnvelope{
		Type:   "error",
		Status: status,
		Error: webSocketErrorView{
			Code:    code,
			Message: message,
		},
	})
	if err != nil {
		return
	}
	_ = writeMessage(
		context.Background(),
		connection,
		websocket.MessageText,
		payload,
	)
}

type webSocketErrorEnvelope struct {
	Type   string             `json:"type"`
	Status int                `json:"status"`
	Error  webSocketErrorView `json:"error"`
}

type webSocketErrorView struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// writeHTTPError 在 Upgrade 前返回标准 JSON，避免鉴权失败进入 WS。
func writeHTTPError(
	response http.ResponseWriter,
	status int,
	code string,
	message string,
) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(webSocketErrorEnvelope{
		Type:   "error",
		Status: status,
		Error: webSocketErrorView{
			Code:    code,
			Message: message,
		},
	})
}
