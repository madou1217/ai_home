// Package codexresponsesws 提供 /v1/responses 的原生 WebSocket 入站传输。
//
// 客户端帧除最小路由观察外保持原样；账号选择、上游认证和运行态提交分别委托
// 给应用层与 Provider 适配器。
package codexresponsesws

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/madou1217/ai_home/internal/transport/http/codexwire"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/admission"
	"github.com/madou1217/ai_home/application/clientkeystats"
	"github.com/madou1217/ai_home/application/codexwebsocket"
	"github.com/madou1217/ai_home/application/effortalign"
	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/application/upstreamretry"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/attemptfailure"
	"github.com/madou1217/ai_home/internal/adapters/codex/responseswebsocket"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
	"github.com/madou1217/ai_home/internal/adapters/upstreamfailure/configured"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

const (
	// Path 与 HTTP Responses API 共用，是否 Upgrade 由 Host Dispatcher 决定。
	Path = "/v1/responses"
	// MaxMessageBytes 限制单个解压后业务消息占用。
	MaxMessageBytes     int64 = codexwire.MaxRequestBytes
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
	// ErrModelChanged 表示客户端在上一轮完成后切换了模型。模型切换不是
	// 非法请求：Responses WebSocket 的连接缓存按模型绑定，代理需要换一条
	// 上游连接后继续复用客户端连接。
	ErrModelChanged = errors.New("Codex Responses WebSocket 模型已切换")
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

// RouteMissReporter 接收精确路由未命中信号，用于异步修正过期的账号模型目录。
type RouteMissReporter interface {
	ReportRouteMiss(providerID string)
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
	// RouteMisses 在目录缺模型时触发 Provider 级重扫；此时请求尚未选中任何账号，
	// 按账号的纠错刷新无从触发。
	RouteMisses RouteMissReporter
	Clock       func() time.Time
	// Rules 可选：账号自定义上游错误规则求值端口。为 nil 表示 Go 未承接该能力，
	// 分类完全由内置观察器决定（与不接入规则时逐字节一致）。
	Rules configured.Rules
	// Routes 可选：每轮选号成功后的路由观测（终端标题的当前账号 / 模型帧）。
	Routes RouteObserver
	// Ladders 可选：目标模型的推理强度档位；nil 表示不对齐，帧原样透传。
	Ladders effortalign.LadderReader
	// Upstream429Retries 可选：上游 WS 握手阶段原始 HTTP 429 有界等待重试控制器。
	// 仅在尚未向任何上游发送业务帧（response.create）的握手阶段生效；连接内帧永不重试。
	Upstream429Retries *upstreamretry.Controller
}

// Handler 管理 Upgrade、连接注册、双向帧代理和终态观察。
type Handler struct {
	authorizer         Authorizer
	selector           Selector
	upstream           UpstreamDialer
	attempts           *inferencegateway.ObservedAttemptRecorder
	modelRefreshes     inferencegateway.ModelRefreshScheduler
	routeMisses        RouteMissReporter
	clock              func() time.Time
	rules              configured.Rules
	routes             RouteObserver
	ladders            effortalign.LadderReader
	upstream429Retries *upstreamretry.Controller
	sessions           *sessionRegistry
	// sessionAccounts 记住每个 Codex 会话上次由哪个账号服务，换号时剥离旧账号的加密推理。
	sessionAccounts *sessionAccounts
	// responseAccounts 记住每个已交付响应的账号归属，续接优先回到原账号。
	responseAccounts *responseAccounts
}

// NewHandler 创建支持并发连接且可显式关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil ||
		dependencies.Selector == nil ||
		dependencies.Upstream == nil ||
		dependencies.Attempts == nil ||
		dependencies.CredentialObservations == nil ||
		dependencies.ModelRefreshes == nil ||
		dependencies.RouteMisses == nil ||
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
		authorizer:         dependencies.Authorizer,
		selector:           dependencies.Selector,
		upstream:           dependencies.Upstream,
		attempts:           attempts,
		modelRefreshes:     dependencies.ModelRefreshes,
		routeMisses:        dependencies.RouteMisses,
		clock:              dependencies.Clock,
		rules:              dependencies.Rules,
		routes:             dependencies.Routes,
		ladders:            dependencies.Ladders,
		upstream429Retries: dependencies.Upstream429Retries,
		sessions:           newSessionRegistry(),
		sessionAccounts:    newSessionAccounts(),
		responseAccounts:   newResponseAccounts(),
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
	// WebSocket 的会话标识来自握手请求头；同一条连接上的所有 turn 共用它。
	request = request.WithContext(clientkeystats.WithRemoteSession(
		request.Context(), request.Header.Get(clientkeystats.RemoteSessionHeader),
	))
	if !handler.available() {
		writeHTTPError(
			response,
			http.StatusServiceUnavailable,
			"websocket_unavailable",
			"Codex Responses WebSocket 当前不可用",
		)
		return
	}
	// 跳数上限（不是「有头即拒」）：跨机中转（本机网关 → 远程 server 网关）是正常拓扑，
	// 只有超过上限才说明出现了 A→B→A 的环。见 responseswebsocket.MaxRelayHops。
	if responseswebsocket.RelayHop(request.Header) > responseswebsocket.MaxRelayHops {
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
	session := newManagedSession(client, request.Context())
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
	pinnedAccountRef := strings.TrimSpace(request.Header.Get("X-Account-Ref"))
	// 显式 X-Account-Ref 优先；没有时按上一轮响应的账号归属钉选（仅亲和偏好，
	// 账号不可用时 Selector 会按 Eligibility 回落到候选池）。
	if pinnedAccountRef == "" && firstRequest.PreviousResponseID != "" {
		if bound, found := handler.responseAccounts.Lookup(firstRequest.PreviousResponseID, handler.clock()); found {
			pinnedAccountRef = bound.String()
		}
	}
	sessionID := strings.TrimSpace(request.Header.Get("Session-Id"))
	upstream, selection, route, connected := handler.connectUpstreamForTurn(
		session,
		firstRequest.Model,
		pinnedAccountRef,
		request.Header,
		request.Host,
	)
	if !connected {
		return
	}
	if upstream == nil || !session.SetUpstream(upstream) {
		if upstream != nil {
			_ = upstream.CloseNow()
		}
		return
	}
	upstream.SetReadLimit(MaxMessageBytes)
	handler.observeRoute(request.Header.Get("X-Session-Id"), selection.AccountRef(), selection.Route().EffectiveModel())
	turn := &turnAdmission{}
	lease, admitErr := handler.admitTurn(session.Context(), selection, route.ModelID().String())
	if admitErr != nil {
		handler.writeAdmissionError(client, admitErr)
		return
	}
	turn.set(lease)
	defer turn.release()
	sendFrame := firstFrame
	if previous, found := handler.sessionAccounts.Swap(
		sessionID,
		selection.AccountRef(),
		handler.clock(),
	); found && previous != selection.AccountRef() {
		session.stripForeignReasoning = true
		sendFrame = stripForeignReasoning(sendFrame)
	}
	observer := newTurnObserver(
		session.Context(),
		firstRequest.Model,
		route,
		selection.CredentialObservation(),
		handler.attempts,
		handler.modelRefreshes,
		handler.clock,
		handler.rules,
		handler.responseAccounts,
	)
	if err := observer.Begin(sendFrame); err != nil {
		writeWebSocketError(
			client,
			http.StatusBadRequest,
			"invalid_response_create",
			"首帧必须是有效的 response.create",
		)
		return
	}
	if err := writeMessage(
		session.Context(),
		upstream,
		websocket.MessageText,
		handler.prepareClientFrame(sendFrame, firstRequest.Model, route.ModelID().String()),
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
	handler.proxy(
		session,
		observer,
		request.Header,
		request.Host,
		pinnedAccountRef,
		sessionID,
		turn,
	)
}

// admitTurn 为一轮 WS 生成获取并发名额（不是每连接一次）。
func (handler *Handler) admitTurn(
	ctx context.Context,
	selection codexwebsocket.Selection,
	model string,
) (*admission.Lease, error) {
	return admission.Acquire(ctx, admission.Request{
		Provider:   string(inference.ProviderCodex),
		AccountRef: selection.AccountRef().String(),
		Model:      model,
	})
}

// admitTurnForObserver 为同一连接上的后续轮次（复用已固定的账号与有效模型）
// 获取并发名额；与首轮一样以 response.create 为单位，而不是整条连接。
func (handler *Handler) admitTurnForObserver(
	ctx context.Context,
	observer *turnObserver,
) (*admission.Lease, error) {
	route := observer.Route()
	return admission.Acquire(ctx, admission.Request{
		Provider:   string(inference.ProviderCodex),
		AccountRef: route.AccountRef().String(),
		Model:      route.ModelID().String(),
	})
}

// writeAdmissionError 把并发准入拒绝写成 WS 错误帧；升级后无法再改 HTTP 状态。
func (handler *Handler) writeAdmissionError(client responseswebsocket.Connection, err error) {
	if _, ok := admission.AsRejection(err); !ok {
		writeWebSocketError(client, http.StatusServiceUnavailable, "no_available_account", "当前没有可用的 Codex 账号")
		return
	}
	writeWebSocketError(
		client,
		http.StatusTooManyRequests,
		admission.CodeAccountTemporarilyUnavailable,
		"Inference capacity is temporarily unavailable, retry later",
	)
}

// turnAdmission 持有本 WS 轮次的准入名额；模型切换时原子替换并释放旧名额。
type turnAdmission struct {
	mu    sync.Mutex
	lease *admission.Lease
}

func (turn *turnAdmission) set(lease *admission.Lease) {
	if turn == nil {
		return
	}
	turn.mu.Lock()
	previous := turn.lease
	turn.lease = lease
	turn.mu.Unlock()
	if previous != nil {
		previous.Release()
	}
}

func (turn *turnAdmission) release() { turn.set(nil) }

// observeRoute 把本轮选号交给可选的路由观测端口；会话键为空或未接入时什么都不做。
func (handler *Handler) observeRoute(sessionKey string, accountRef accountcore.AccountRef, model string) {
	if handler.routes == nil || strings.TrimSpace(sessionKey) == "" {
		return
	}
	handler.routes.ObserveRoute(strings.TrimSpace(sessionKey), accountRef.String(), model)
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
	clientHeader http.Header,
	localAuthority string,
	pinnedAccountRef string,
	sessionID string,
	turn *turnAdmission,
) {
	for {
		results := make(chan pumpResult, 2)
		go handler.pumpClientToUpstream(session, observer, turn, results)
		go pumpUpstreamToClient(session, observer, turn, results)
		result := <-results
		if len(result.modelSwitch) > 0 {
			// The client pump has consumed the new response.create. Close only the
			// old upstream so the other pump can leave, then establish a fresh
			// model-bound upstream while keeping the client WebSocket alive.
			oldUpstream := session.Upstream()
			if oldUpstream != nil {
				_ = oldUpstream.CloseNow()
			}
			<-results
			// 上一轮已经结束：先归还名额，避免同一账号上限为 1 时新轮次被自己挡住。
			turn.release()
			nextObserver, switched := handler.switchModel(
				session,
				result.modelSwitch,
				result.model,
				clientHeader,
				localAuthority,
				pinnedAccountRef,
				sessionID,
				turn,
			)
			if !switched {
				session.Cancel()
				return
			}
			observer = nextObserver
			continue
		}
		if result.source == pumpSourceUpstream &&
			result.recordIncomplete &&
			!session.Closing() &&
			observer.ActiveGenerating() {
			failure, err := attemptfailure.NewIncompleteStream(result.err)
			if err == nil {
				recorded, recordErr := recordCodexFailure(
					context.Background(),
					handler.attempts,
					handler.modelRefreshes,
					observer.Route(),
					observer.CredentialObservation(),
					failure,
				)
				if recordErr == nil && recorded && !observer.Committed() && isRetryableFailoverKind(failure.RuntimeKind()) {
					result.closeCode = websocket.StatusInternalError
					result.closeReason = retryableFailoverCloseReason
				}
			}
		}
		propagateClose(result, session.Other(result.source))
		session.Cancel()
		<-results
		return
	}
}

// switchModel moves a completed client session to a new connection-bound
// model. The current response.create is already a full non-incremental frame
// when Codex changes models, so it is safe to send it to a fresh upstream WS.
func (handler *Handler) switchModel(
	session *managedSession,
	frame []byte,
	model string,
	clientHeader http.Header,
	localAuthority string,
	pinnedAccountRef string,
	sessionID string,
	turn *turnAdmission,
) (*turnObserver, bool) {
	if handler == nil || session == nil || strings.TrimSpace(model) == "" {
		return nil, false
	}
	upstream, selection, route, connected := handler.connectUpstreamForTurn(
		session,
		model,
		pinnedAccountRef,
		clientHeader,
		localAuthority,
	)
	if !connected {
		return nil, false
	}
	if upstream == nil || !session.ReplaceUpstream(upstream) {
		if upstream != nil {
			_ = upstream.CloseNow()
		}
		return nil, false
	}
	upstream.SetReadLimit(MaxMessageBytes)
	handler.observeRoute(clientHeader.Get("X-Session-Id"), selection.AccountRef(), selection.Route().EffectiveModel())
	lease, admitErr := handler.admitTurn(session.Context(), selection, route.ModelID().String())
	if admitErr != nil {
		_ = upstream.CloseNow()
		handler.writeAdmissionError(session.Client(), admitErr)
		return nil, false
	}
	turn.set(lease)
	sendFrame := frame
	if previous, found := handler.sessionAccounts.Swap(sessionID, selection.AccountRef(), handler.clock()); found && previous != selection.AccountRef() {
		session.stripForeignReasoning = true
		sendFrame = stripForeignReasoning(sendFrame)
	}
	observer := newTurnObserver(
		session.Context(),
		model,
		route,
		selection.CredentialObservation(),
		handler.attempts,
		handler.modelRefreshes,
		handler.clock,
		handler.rules,
		handler.responseAccounts,
	)
	if err := observer.Begin(sendFrame); err != nil {
		_ = upstream.CloseNow()
		writeWebSocketError(session.Client(), http.StatusBadRequest, "invalid_response_create", "首帧必须是有效的 response.create")
		return nil, false
	}
	if err := writeMessage(
		session.Context(),
		upstream,
		websocket.MessageText,
		handler.prepareClientFrame(sendFrame, model, selection.Route().EffectiveModel()),
	); err != nil {
		handler.recordTransportFailure(route, selection.CredentialObservation(), err)
		_ = upstream.CloseNow()
		writeWebSocketError(session.Client(), http.StatusBadGateway, "upstream_write_failed", "Codex WebSocket 上游写入失败")
		return nil, false
	}
	return observer, true
}

// handleDialFailure 把真实握手 HTTP 错误或传输错误提交到统一运行态。
func (handler *Handler) handleDialFailure(
	client responseswebsocket.Connection,
	route runtimecore.ModelRoute,
	observation accountcredentials.CredentialObservation,
	response *http.Response,
	dialErr error,
) {
	var prefix []byte
	var readErr error
	if response != nil && response.Body != nil {
		prefix, readErr = io.ReadAll(io.LimitReader(response.Body, sharedfailure.MaxErrorPayloadBytes+1))
		_ = response.Body.Close()
	}
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
	failure, err := handler.classifyDialFailure(route, response, prefix, readErr, dialErr)
	if err == nil && failure.IsValid() {
		_, _ = recordCodexFailure(
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
		if failure.RuntimeKind() == runtimecore.FailureUpstreamEdgeRejected {
			// 站点边缘拒绝（WAF 拦截页 / 网关请求格式拒绝）与账号无关：交付网关 502，
			// 不透传上游的 401/403 拦截页（与 Node 的 edge policy 同语义）。
			status = http.StatusBadGateway
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
		_, _ = recordCodexFailure(
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
	if errors.Is(err, codexwebsocket.ErrInvalidPinnedAccount) {
		status = http.StatusBadRequest
		code = "invalid_account_ref"
		message = "Codex WebSocket 钉选账号引用无效"
	} else if errors.Is(err, codexwebsocket.ErrInvalidRequest) ||
		errors.Is(err, codexwebsocket.ErrModelRewriteRequired) {
		status = http.StatusBadRequest
		code = "native_model_not_exact"
		message = "Codex WebSocket 必须使用目录中的精确模型"
	} else if errors.Is(err, inferencegateway.ErrRouteNotFound) {
		status = http.StatusNotFound
		code = "model_not_found"
		message = "当前没有对应的 Codex WebSocket 模型路由"
		handler.routeMisses.ReportRouteMiss(string(inference.ProviderCodex))
	} else if rejection, ok := inferenceapi.ClientKeyScopeRejectionOf(err); ok {
		status = rejection.Status
		code = rejection.Code
		message = rejection.Message
	} else if errors.Is(err, accountrouting.ErrConcurrencyExhausted) {
		// 账号存在，只是整轮候选都被自己的并发天花板占满：与准入拒绝同形，
		// 让客户端稍后重试，而不是让用户以为没有 Codex 账号。
		status = http.StatusTooManyRequests
		code = admission.CodeAccountTemporarilyUnavailable
		message = "Inference capacity is temporarily unavailable, retry later"
	}
	// 选号阶段失败时把稳定码与错误文本写进服务端日志：WS 客户端只会看到
	// 一帧错误，服务端过去没有对应记录，无法判断是“没有候选”还是候选被挡下。
	log.Printf("codex responses ws selection failed code=%s err=%q", code, err.Error())
	writeWebSocketError(client, status, code, message)
}

// parseClientFrame 只观察路由和串行状态所需字段，不拒绝任何未知字段。
func parseClientFrame(payload []byte, boundModel ...string) (clientRequestEnvelope, error) {
	var request clientRequestEnvelope
	if json.Unmarshal(payload, &request) != nil ||
		request.Type != "response.create" {
		return clientRequestEnvelope{}, ErrInvalidClientFrame
	}
	// Codex sends the model on the first response.create and may omit it on
	// later turns of the same WebSocket. The connection is already bound to the
	// first model, so inherit that value for validation while still rejecting a
	// real model switch.
	if request.Model == "" && len(boundModel) > 0 {
		request.Model = strings.TrimSpace(boundModel[0])
	}
	modelID, err := runtimecore.NewModelID(request.Model)
	if err != nil || modelID.String() != request.Model {
		return clientRequestEnvelope{}, ErrInvalidClientFrame
	}
	return request, nil
}

// prepareClientFrame retains the existing fresh-upstream sanitization policy.
// Later turns use prepareBoundClientFrame: connection-local response references
// and same-account encrypted reasoning must survive on that existing peer.
func (handler *Handler) prepareClientFrame(payload []byte, model string, effectiveModel string) []byte {
	return codexwire.SanitizeRequestPayload(handler.prepareBoundClientFrame(payload, model, effectiveModel))
}

// normalizeClientFrameModel restores the connection-bound model for later turns
// that omitted it; the upstream still expects a model in every request body.
func normalizeClientFrameModel(payload []byte, model string) []byte {
	bound := strings.TrimSpace(model)
	if bound == "" {
		return payload
	}
	var frame map[string]json.RawMessage
	if json.Unmarshal(payload, &frame) != nil {
		return payload
	}
	if raw, ok := frame["model"]; ok {
		var existing string
		if json.Unmarshal(raw, &existing) == nil && strings.TrimSpace(existing) != "" {
			return payload
		}
	}
	encoded, err := json.Marshal(bound)
	if err != nil {
		return payload
	}
	frame["model"] = encoded
	normalized, err := json.Marshal(frame)
	if err != nil {
		return payload
	}
	return normalized
}

// clientRequestEnvelope 是 response.create 的有界最小观察投影。
type clientRequestEnvelope struct {
	Type               string `json:"type"`
	Model              string `json:"model"`
	PreviousResponseID string `json:"previous_response_id"`
	Generate           *bool  `json:"generate"`
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
