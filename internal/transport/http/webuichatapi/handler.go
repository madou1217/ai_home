package webuichatapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/attemptfailure"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

const (
	// CollectionPath 是 WebUI Chat 会话集合前缀，与 Node webui-chat-runtime-routes 一致。
	CollectionPath = "/v0/webui/chat/sessions/"
	// ManagementCollectionPath 是 Node 轮次执行调用本切片的内部入口。
	//
	// 浏览器路由仍由 Node 拥有（202 + 独立 SSE 的语义不能变），所以 Go 不使用浏览器
	// 路径，而是挂在管理前缀下，只接受带 Management Key 的内部调用。
	ManagementCollectionPath = "/v1/management/webui/chat/sessions/"
	// DefaultMaxBodyBytes 与 Node readJsonBody 的默认上限一致（1MB）。
	DefaultMaxBodyBytes int64 = 1024 * 1024
	// DefaultMaxAttempts 与 relaycore 的上游尝试上限一致：账号池很大时不设上限
	// 会让单个请求长时间打转，客户端只观察到超时。
	DefaultMaxAttempts = 4
	// DefaultHeartbeatInterval 与 Node DEFAULT_HEARTBEAT_MS 一致。
	DefaultHeartbeatInterval = 15 * time.Second
	// maxFailureMessageLength 与 Node sanitizeDiagnosticText 的默认上限一致。
	maxFailureMessageLength = 512
	// statusBadRequest / statusUnprocessableEntity 是路由错误里最常用的两个状态。
	statusBadRequest          = http.StatusBadRequest
	statusUnprocessableEntity = http.StatusUnprocessableEntity
)

// AccountSource 按模型产出候选账号（复用 relaycore 的征召端口）。
type AccountSource = relaycore.AccountSource

// AccountCursor 按调度顺序逐个产出账号。
type AccountCursor = relaycore.AccountCursor

// CredentialResolver 延迟读取并刷新目标账号凭据。
type CredentialResolver = relaycore.CredentialResolver

// HTTPClient 是发起单个上游请求所需的最小端口。
type HTTPClient = relaycore.HTTPClient

// UsageRecorder 接收一次请求的真实 token 用量（复用 relaycore 的记账端口）。
type UsageRecorder = relaycore.UsageRecorder

// Authorizer 校验内部调用方的管理凭据。
//
// 本切片挂在管理前缀下，任何能访问 loopback 的进程都能伪造一轮对话（消耗账号额度），
// 因此鉴权是必需依赖而不是可选装饰：装配期缺它必须失败，而不是运行期放行。
type Authorizer interface {
	Authorized(*http.Request) bool
}

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("WebUI Chat HTTP Handler 依赖无效")

// Dependencies 集中声明本切片用到的账号、凭据、Provider、传输与记账端口。
//
// 除 Usage 外全部必需：缺任何一项都无法在失败时给出确定的结论，因此宁可装配期报错，
// 也不要运行期静默降级。
type Dependencies struct {
	// Authorizer 校验管理凭据（必需）。
	Authorizer Authorizer
	// PathPrefix 覆盖指令入口前缀；为空时用 CollectionPath。
	//
	// 生产接线挂 ManagementCollectionPath，测试与历史兼容路径用默认值。
	PathPrefix string
	// Accounts 按调度顺序提供候选账号（生产接线复用 relaycore.AccountSourceChain）。
	Accounts AccountSource
	// Credentials 读取目标账号的 Provider 归属与凭据。
	Credentials CredentialResolver
	// Provider 是本切片服务的上游差异面（端点、鉴权、改写、失败分类）。
	Provider relaycore.Provider
	// Client 发起上游请求。
	Client HTTPClient
	// Attempts 记录运行态（成功与失败都要记，否则仪表盘上看不到 Go 承接的请求）。
	Attempts inferencegateway.AttemptRecorder
	// Usage 记录真实 token 用量；为空时本通道不产生用量事实。
	Usage UsageRecorder
	// Clock 提供时间（可注入，便于测试）。
	Clock func() time.Time
	// NewID 生成事件与轮次标识；为空时用内置随机 UUID。
	NewID func(prefix string) string
	// MaxBodyBytes 覆盖请求体上限。
	MaxBodyBytes int64
	// MaxAttempts 覆盖上游尝试次数上限。
	MaxAttempts int
	// HeartbeatInterval 覆盖 SSE 心跳间隔；<= 0 表示关闭心跳。
	HeartbeatInterval time.Duration
}

// Handler 编排一次 turn.submit：校验指令、征召账号、请求上游、回写 SSE、结算用量。
type Handler struct {
	authorizer        Authorizer
	commandPath       string
	accounts          AccountSource
	credentials       CredentialResolver
	provider          relaycore.Provider
	client            HTTPClient
	attempts          *inferencegateway.ObservedAttemptRecorder
	usage             UsageRecorder
	clock             func() time.Time
	newID             func(string) string
	maxBodyBytes      int64
	maxAttempts       int
	heartbeatInterval time.Duration
}

// NewHandler 创建默认失败关闭的 WebUI Chat 切片。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil ||
		dependencies.Accounts == nil ||
		dependencies.Credentials == nil ||
		dependencies.Provider == nil ||
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
	maxBodyBytes := dependencies.MaxBodyBytes
	if maxBodyBytes <= 0 {
		maxBodyBytes = DefaultMaxBodyBytes
	}
	maxAttempts := dependencies.MaxAttempts
	if maxAttempts <= 0 {
		maxAttempts = DefaultMaxAttempts
	}
	heartbeat := dependencies.HeartbeatInterval
	if heartbeat == 0 {
		heartbeat = DefaultHeartbeatInterval
	}
	newID := dependencies.NewID
	if newID == nil {
		newID = newIdentifier
	}
	commandPath := dependencies.PathPrefix
	if commandPath == "" {
		commandPath = CollectionPath
	}
	if !strings.HasSuffix(commandPath, "/") {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer:        dependencies.Authorizer,
		commandPath:       commandPath,
		accounts:          dependencies.Accounts,
		credentials:       dependencies.Credentials,
		provider:          dependencies.Provider,
		client:            dependencies.Client,
		attempts:          attempts,
		usage:             dependencies.Usage,
		clock:             dependencies.Clock,
		newID:             newID,
		maxBodyBytes:      maxBodyBytes,
		maxAttempts:       maxAttempts,
		heartbeatInterval: heartbeat,
	}, nil
}

// ServeHTTP 处理 POST <PathPrefix>{sessionId}/commands。
//
// 生产接线的前缀是 ManagementCollectionPath：浏览器仍走 Node 的 /v0/webui/chat/*，
// 由 Node 的轮次执行把指令转发到这里。
//
// 与 Node 的差异：Node 先返回 202 再由另一条 SSE 连接交付事件；这里把两条连接合成
// 一条，因此凡是「还没向客户端写过字节」的失败都以 JSON 错误返回（与 Node 路由错误
// 的形状一致），写过之后才改用 turn.failed 事件。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if !handler.authorizer.Authorized(request) {
		writeRouteError(response, newRouteError(
			http.StatusUnauthorized, "chat_runtime_unauthorized", "管理凭据无效", nil,
		))
		return
	}
	sessionID, matched := matchCommandPath(request.URL.Path, handler.commandPath)
	if !matched {
		writeRouteError(response, newRouteError(
			http.StatusNotFound, "chat_runtime_route_not_found", "没有这个聊天路由", nil,
		))
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeRouteError(response, newRouteError(
			http.StatusMethodNotAllowed, "chat_runtime_method_not_allowed", "聊天指令只接受 POST", nil,
		))
		return
	}
	document, err := readRequestBody(request, handler.maxBodyBytes)
	if err != nil {
		writeRouteError(response, newRouteError(
			statusBadRequest, "invalid_chat_runtime_payload", "聊天指令无法读取", nil,
		))
		return
	}
	command, routeErr := decodeTurnSubmit(document)
	if routeErr != nil {
		writeRouteError(response, routeErr)
		return
	}
	if command.Model == "" {
		// Node 的模型来自会话策略，本切片没有会话存储，只能要求调用方显式给出。
		writeRouteError(response, newRouteError(
			statusUnprocessableEntity, "chat_turn_model_required", "本轮必须指定 model", nil,
		))
		return
	}
	if len(command.AttachmentIDs) > 0 {
		// 附件需要会话级附件仓库，本切片没有；明确拒绝好过悄悄丢掉用户上传的文件。
		writeRouteError(response, newRouteError(
			http.StatusServiceUnavailable, "chat_attachment_store_unavailable", "本切片尚未接入附件仓库", nil,
		))
		return
	}
	// 客户端断开或写失败时取消上游读取：Node 的轮次与会话解耦、断线不取消，
	// 本切片是单连接内联流，断线即取消（见 REPORT.md）。
	ctx, cancel := context.WithCancel(request.Context())
	defer cancel()
	call, routeErr := handler.openUpstream(ctx, request, command)
	if routeErr != nil {
		writeRouteError(response, routeErr)
		return
	}
	defer call.close()
	handler.deliver(ctx, response, sessionID, command, call)
}

// upstreamCall 是一次已经拿到上游成功响应的尝试。
type upstreamCall struct {
	response    *http.Response
	reader      *chatStreamReader
	body        io.ReadCloser
	route       runtimecore.ModelRoute
	observation accountcredentials.CredentialObservation
	providerID  string
	// first 是提交前预读到的第一块增量（可能就是唯一一块）。
	first    chunk
	hasFirst bool
	usage    inference.Usage
	hasUsage bool
}

// close 释放上游连接。
func (call *upstreamCall) close() {
	if call == nil || call.body == nil {
		return
	}
	_ = call.body.Close()
	call.body = nil
}

// openUpstream 征召账号并拿到一条可流式交付的上游成功响应。
func (handler *Handler) openUpstream(
	ctx context.Context,
	request *http.Request,
	command turnCommand,
) (*upstreamCall, *routeError) {
	modelID, err := runtimecore.NewModelID(command.Model)
	if err != nil {
		return nil, newRouteError(
			statusUnprocessableEntity, "chat_turn_model_control_invalid",
			"模型标识不符合上游合同", map[string]any{"key": "model"},
		)
	}
	source, routeErr := handler.resolveAccountSource(request)
	if routeErr != nil {
		return nil, routeErr
	}
	cursor, err := source.Accounts(ctx, modelID)
	if err != nil || cursor == nil {
		return nil, newRouteError(
			http.StatusServiceUnavailable, "chat_runtime_unavailable", "账号调度当前不可用", nil,
		)
	}
	attempted := false
	var last *routeError
	for range handler.maxAttempts {
		accountRef, found, nextErr := cursor.Next(ctx)
		if nextErr != nil || !found {
			break
		}
		attempted = true
		call, failure, retry := handler.attempt(ctx, accountRef, modelID, command)
		if call != nil {
			return call, nil
		}
		last = failure
		if !retry || ctx.Err() != nil {
			break
		}
	}
	if !attempted {
		return nil, newRouteError(
			http.StatusServiceUnavailable, "chat_account_unavailable", "没有可用账号", nil,
		)
	}
	if last == nil {
		last = newRouteError(
			http.StatusServiceUnavailable, "chat_account_unavailable", "没有可用账号", nil,
		)
	}
	return nil, last
}

// resolveAccountSource 处理钉选账号请求头。
//
// 钉选语义与 relaycore 一致：调用方明确指定账号时只用该账号，不换号——换号会让
// 「用这个账号发」变成「随便找个账号发」。
func (handler *Handler) resolveAccountSource(request *http.Request) (AccountSource, *routeError) {
	values := request.Header.Values(inferenceapi.AccountRefHeader)
	if len(values) == 0 {
		return handler.accounts, nil
	}
	if len(values) != 1 {
		return nil, newRouteError(
			statusBadRequest, "invalid_account_ref_header", "固定账号请求头重复", nil,
		)
	}
	accountRef, err := accountcore.ParseAccountRef(strings.TrimSpace(values[0]))
	if err != nil {
		return nil, newRouteError(
			statusBadRequest, "invalid_account_ref_header", "固定账号请求头不是规范账号引用", nil,
		)
	}
	return &pinnedAccountSource{inner: handler.accounts, accountRef: accountRef}, nil
}

// pinnedAccountSource 只放行指定账号；找不到就报告没有可用账号。
type pinnedAccountSource struct {
	inner      AccountSource
	accountRef accountcore.AccountRef
}

func (source *pinnedAccountSource) Accounts(
	ctx context.Context,
	modelID runtimecore.ModelID,
) (AccountCursor, error) {
	cursor, err := source.inner.Accounts(ctx, modelID)
	if err != nil || cursor == nil {
		return nil, err
	}
	return &pinnedAccountCursor{cursor: cursor, accountRef: source.accountRef}, nil
}

// pinnedAccountCursor 跳过非钉选账号，并限制扫描量避免在超大账号池里空转。
type pinnedAccountCursor struct {
	cursor     AccountCursor
	accountRef accountcore.AccountRef
	scanned    int
}

// pinnedScanLimit 与尝试上限无关：扫描只是找钉选账号，不需要遍历整个池。
const pinnedScanLimit = 256

func (cursor *pinnedAccountCursor) Next(ctx context.Context) (accountcore.AccountRef, bool, error) {
	for cursor.scanned < pinnedScanLimit {
		cursor.scanned++
		accountRef, found, err := cursor.cursor.Next(ctx)
		if err != nil || !found {
			return "", false, err
		}
		if accountRef == cursor.accountRef {
			return accountRef, true, nil
		}
	}
	return "", false, nil
}

// attempt 用指定账号执行一次上游请求，并预读第一块增量。
//
// 关键约束：本函数不向客户端写任何字节——只有确认上游真的开始产出，才值得提交 SSE。
func (handler *Handler) attempt(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	modelID runtimecore.ModelID,
	command turnCommand,
) (*upstreamCall, *routeError, bool) {
	route, err := runtimecore.NewModelRoute(accountRef, modelID.String())
	if err != nil {
		return nil, newRouteError(
			http.StatusBadGateway, "chat_runtime_state_unavailable", "运行态不可用", nil,
		), false
	}
	binding, observation, err := handler.credentials.ResolveObservedCredentialBinding(ctx, accountRef)
	if err != nil ||
		!binding.IsValid() ||
		binding.AccountRef() != accountRef ||
		!observation.IsValid() ||
		observation.AccountRef() != accountRef {
		// 凭据读取失败属该账号自身问题，换号可能成功。
		return nil, newRouteError(
			http.StatusServiceUnavailable, "chat_account_unavailable", "该账号凭据当前不可用", nil,
		), true
	}
	provider, ok := handler.provider.Resolve(relaycore.ResolveInput{
		ProviderID: binding.ProviderID(),
		AccountRef: accountRef.String(),
		ModelID:    modelID,
		Credential: binding.Credential(),
	})
	if !ok {
		return nil, newRouteError(
			statusUnprocessableEntity, "unsupported_chat_account", "该账号不属于本通道服务的 Provider", nil,
		), false
	}
	token, err := provider.AccessToken(binding.Credential())
	if err != nil {
		// 凭据形态不适配是账号的确定性属性：换号只会让同类账号被系统性跳过。
		return nil, newRouteError(
			statusUnprocessableEntity, "unsupported_chat_account", "该账号必须使用原生登录态", nil,
		), false
	}
	rewritten, err := provider.RewriteRequest(buildUpstreamBody(command))
	if err != nil {
		return nil, newRouteError(
			statusBadRequest, "invalid_chat_upstream_request", "上游无法表达本轮请求", nil,
		), false
	}
	endpoint, ok := provider.Endpoint()
	if !ok {
		return nil, newRouteError(
			statusUnprocessableEntity, "unsupported_chat_account", "该账号没有可用的上游端点", nil,
		), false
	}
	upstream, err := http.NewRequestWithContext(
		ctx, http.MethodPost, endpoint, bytes.NewReader(rewritten.Body),
	)
	if err != nil {
		return nil, newRouteError(
			statusBadRequest, "invalid_chat_upstream_request", "上游请求构造失败", nil,
		), false
	}
	provider.DecorateUpstream(upstream, token)
	upstreamResponse, err := handler.client.Do(upstream)
	if err != nil || upstreamResponse == nil || upstreamResponse.Body == nil {
		return nil, handler.recordTransportFailure(ctx, route, observation, err), true
	}
	if upstreamResponse.StatusCode < http.StatusOK || upstreamResponse.StatusCode >= http.StatusMultipleChoices {
		failure, retry := handler.recordHTTPFailure(ctx, provider, route, observation, upstreamResponse)
		return nil, failure, retry
	}
	// 成功也要记账：否则运行态与仪表盘看不到这个账号在工作。
	handler.recordSuccess(ctx, route, observation)
	call := &upstreamCall{
		response:    upstreamResponse,
		body:        upstreamResponse.Body,
		route:       route,
		observation: observation,
		providerID:  provider.ID(),
	}
	if isEventStream(upstreamResponse.Header) {
		call.reader = newChatStreamReader(upstreamResponse.Body)
		first, hasFirst, peekErr := call.reader.Next()
		if peekErr != nil {
			call.close()
			return nil, handler.recordStreamFailure(ctx, route, observation, peekErr), false
		}
		call.first, call.hasFirst = first, hasFirst
		return call, nil, false
	}
	// 上游忽略了 stream:true：把整段响应当作一块增量，前端仍然看到一次完整流。
	first, usage, hasUsage, readErr := readChatCompletionDocument(upstreamResponse.Body)
	if readErr != nil {
		call.close()
		return nil, handler.recordStreamFailure(ctx, route, observation, readErr), false
	}
	call.first, call.hasFirst = first, first.Content != "" || first.FinishReason != ""
	call.usage, call.hasUsage = usage, hasUsage
	return call, nil, false
}

// deliver 提交 SSE 并交付本轮事件。
func (handler *Handler) deliver(
	ctx context.Context,
	response http.ResponseWriter,
	sessionID string,
	command turnCommand,
	call *upstreamCall,
) {
	stream, err := newEventStream(
		response,
		sessionID,
		eventSource{Provider: call.providerID, RuntimeID: runtimeID},
		handler.clock,
		handler.newID,
	)
	if err != nil {
		writeRouteError(response, newRouteError(
			http.StatusInternalServerError, "chat_runtime_stream_unsupported",
			"当前连接不支持流式交付", nil,
		))
		return
	}
	turn := &turnState{
		turnID:    handler.newID("turn"),
		runID:     handler.newID("run"),
		itemID:    handler.newID("item"),
		model:     command.Model,
		startedAt: handler.clock(),
	}
	if err := stream.open(); err != nil {
		return
	}
	defer stream.close()
	stream.startHeartbeat(handler.heartbeatInterval)

	// 先宣告「本轮已受理、已开始」：前端据此把会话状态切到 running，
	// 否则首个 token 之前的等待没有任何可渲染的状态。
	if err := stream.emit(
		eventTypeTurnQueued, turn.turnID, turn.runID, "",
		turnPayload{
			State:               sessionStateStarting,
			SubmissionCommandID: command.CommandID,
			ActiveTurn:          turn.activeTurn(sessionStateStarting),
		},
	); err != nil {
		return
	}
	if err := stream.emit(
		eventTypeTurnStarted, turn.turnID, turn.runID, "",
		turnPayload{
			State:      sessionStateRunning,
			ActiveTurn: turn.activeTurn(sessionStateRunning),
		},
	); err != nil {
		return
	}

	if pumpErr := handler.pump(stream, turn, call); pumpErr != nil {
		handler.abortTurn(ctx, stream, turn, call, pumpErr)
		return
	}
	handler.completeTurn(ctx, stream, turn, call)
}

// pump 把上游增量翻译成时间线事件。
func (handler *Handler) pump(stream *eventStream, turn *turnState, call *upstreamCall) error {
	if call.hasFirst {
		if err := handler.emitContent(stream, turn, call.first.Content); err != nil {
			return err
		}
	}
	if call.reader == nil {
		// 非流式回退：整段内容已经作为首块交付，用量在 attempt 里读好了。
		return nil
	}
	for {
		next, ok, err := call.reader.Next()
		if err != nil {
			return err
		}
		if !ok {
			break
		}
		if err := handler.emitContent(stream, turn, next.Content); err != nil {
			return err
		}
		if stream.Failed() {
			return errStreamClosed
		}
	}
	usage, hasUsage := call.reader.Result()
	call.usage, call.hasUsage = usage, hasUsage
	return nil
}

// emitContent 在首个可见增量处补 started，然后写 delta。
//
// 为什么 started 必须等首个增量：Node 的事件桥只在有正文时才建条目，
// 空回复（上游零内容）不该在时间线上留下一条永远 streaming 的空气泡。
func (handler *Handler) emitContent(stream *eventStream, turn *turnState, content string) error {
	if content == "" {
		return nil
	}
	if !turn.itemStarted {
		turn.itemStarted = true
		turn.firstTokenAt = handler.clock()
		if err := stream.emit(
			eventTypeTimelineItemStarted, turn.turnID, turn.runID, turn.itemID,
			timelinePayload{Item: turn.item(messageDetail{
				Role:  "assistant",
				Model: turn.model,
			}, timelineStatusRunning, turn.startedAt)},
		); err != nil {
			return err
		}
	}
	turn.content.WriteString(content)
	return stream.emit(
		eventTypeTimelineItemDelta, turn.turnID, turn.runID, turn.itemID,
		deltaPayload{ItemID: turn.itemID, Chunk: content},
	)
}

// completeTurn 结算用量并交付收尾事件。
//
// 事件顺序与 Node store.settleTurn 一致：先补最终 timeline.item.completed（带 metrics），
// 再发 turn.completed——前端靠这个顺序把「消息完成」与「轮次结束」分成两帧处理。
func (handler *Handler) completeTurn(
	ctx context.Context,
	stream *eventStream,
	turn *turnState,
	call *upstreamCall,
) {
	completedAt := handler.clock()
	handler.recordUsage(ctx, call)
	if turn.itemStarted {
		detail := messageDetail{Role: "assistant", Model: turn.model}
		metrics := turn.metrics(completedAt, call.usage, call.hasUsage)
		detail.Metrics = &metrics
		_ = stream.emit(
			eventTypeTimelineItemCompleted, turn.turnID, turn.runID, turn.itemID,
			timelinePayload{Item: turn.item(detail, timelineStatusCompleted, completedAt)},
		)
	}
	_ = stream.emit(
		eventTypeTurnCompleted, turn.turnID, turn.runID, "",
		turnCompletedPayload{State: sessionStateIdle},
	)
}

// abortTurn 交付失败终态。
//
// 客户端已经断开时不再写事件：写不进去，而且这不是「轮次失败」，是「没人看了」。
func (handler *Handler) abortTurn(
	ctx context.Context,
	stream *eventStream,
	turn *turnState,
	call *upstreamCall,
	failure error,
) {
	if ctx.Err() != nil || stream.Failed() {
		// 客户端断开不是账号的问题：这里不写运行态失败。
		// 否则一次用户关页面就可能让健康账号进入 cooldown，把「没人看」误记成「上游坏了」。
		return
	}
	detail := streamFailureDetail(failure)
	completedAt := handler.clock()
	if turn.itemStarted {
		// 与 Node finishInTransaction 同口径：失败的轮次也要把条目收口成 failed，
		// 否则时间线上会留下一条永远 running 的消息。
		itemDetail := messageDetail{Role: "assistant", Model: turn.model}
		metrics := turn.metrics(completedAt, call.usage, call.hasUsage)
		itemDetail.Metrics = &metrics
		_ = stream.emit(
			eventTypeTimelineItemCompleted, turn.turnID, turn.runID, turn.itemID,
			timelinePayload{Item: turn.item(itemDetail, timelineStatusFailed, completedAt)},
		)
	}
	_ = stream.emit(
		eventTypeTurnFailed, turn.turnID, turn.runID, "",
		turnFailedPayload{State: sessionStateIdle, Retryable: true, Error: detail},
	)
	handler.recordStreamFailure(context.WithoutCancel(ctx), call.route, call.observation, failure)
}

// turnState 是一轮请求内的身份与聚合状态。
type turnState struct {
	turnID       string
	runID        string
	itemID       string
	model        string
	startedAt    time.Time
	firstTokenAt time.Time
	content      strings.Builder
	itemStarted  bool
}

// activeTurn 返回事件里的轮次快照。
//
// clientUserMessageId 与 Node 一样取 runId：Node 的 createRun 就是把它设成 runId，
// 前端拿它把用户消息与轮次对上。
func (turn *turnState) activeTurn(state string) activeTurn {
	return activeTurn{
		TurnID:              turn.turnID,
		RunID:               turn.runID,
		ClientUserMessageID: turn.runID,
		StartedAt:           turn.startedAt.UnixMilli(),
		State:               state,
	}
}

// item 组装一条助手消息条目。
func (turn *turnState) item(detail messageDetail, status string, updatedAt time.Time) timelineItem {
	return timelineItem{
		ID:        turn.itemID,
		Kind:      timelineKindMessage,
		CreatedAt: turn.startedAt.UnixMilli(),
		UpdatedAt: updatedAt.UnixMilli(),
		Status:    status,
		Content:   turn.content.String(),
		Detail:    detail,
		TurnID:    turn.turnID,
	}
}

// metrics 计算详情里的用量汇总，规则与 Node turn-metrics-repository.finishInTransaction 一致：
// durationMs 必有；ttftMs 只在真的有首个可见增量时出现且不超过总时长；
// tokensPerSec 只在解码耗时 ≥500ms 且输出 token > 0 时出现（太短的样本没有意义）。
func (turn *turnState) metrics(
	completedAt time.Time,
	usage inference.Usage,
	hasUsage bool,
) messageMetrics {
	durationMS := completedAt.Sub(turn.startedAt).Milliseconds()
	if durationMS < 0 {
		durationMS = 0
	}
	metrics := messageMetrics{DurationMS: durationMS}
	if !turn.firstTokenAt.IsZero() {
		ttftMS := turn.firstTokenAt.Sub(turn.startedAt).Milliseconds()
		if ttftMS < 0 {
			ttftMS = 0
		}
		if ttftMS > durationMS {
			ttftMS = durationMS
		}
		metrics.TTFTMS = &ttftMS
		decodeMS := durationMS - ttftMS
		if hasUsage && usage.OutputTokens() > 0 && decodeMS >= 500 {
			rate := float64(usage.OutputTokens()) / (float64(decodeMS) / 1000)
			metrics.TokensPerSec = &rate
		}
	}
	if hasUsage {
		input := usage.InputTokens()
		output := usage.OutputTokens()
		metrics.InputTokens = &input
		metrics.OutputTokens = &output
	}
	return metrics
}

// buildUpstreamBody 构造一次 OpenAI chat.completions 流式请求。
//
// 会话事实（历史消息）由 Node 随指令带来：本切片不持有会话，不能猜也不能补；
// 调用方没带 messages 时退化成只发本轮正文，保持旧行为。
func buildUpstreamBody(command turnCommand) []byte {
	messages := make([]map[string]string, 0, len(command.Messages)+1)
	if len(command.Messages) > 0 {
		for _, message := range command.Messages {
			messages = append(messages, map[string]string{"role": message.Role, "content": message.Content})
		}
	} else {
		messages = append(messages, map[string]string{"role": "user", "content": command.Content})
	}
	body := map[string]any{
		"model":    command.Model,
		"messages": messages,
		"stream":   true,
		// include_usage 让上游在最后一帧带上用量；没有它就没法记账。
		"stream_options": map[string]any{"include_usage": true},
	}
	if command.ReasoningEffort != "" {
		body["reasoning_effort"] = command.ReasoningEffort
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return []byte("{}")
	}
	return encoded
}

// recordSuccess 记录一次成功尝试。
func (handler *Handler) recordSuccess(
	ctx context.Context,
	route runtimecore.ModelRoute,
	observation accountcredentials.CredentialObservation,
) {
	success, err := inferencegateway.NewAttemptSuccess(handler.clock())
	if err != nil {
		return
	}
	_, _ = handler.attempts.RecordSuccess(ctx, route, observation, success)
}

// recordTransportFailure 记录没有拿到上游响应的传输失败。
func (handler *Handler) recordTransportFailure(
	ctx context.Context,
	route runtimecore.ModelRoute,
	observation accountcredentials.CredentialObservation,
	transportErr error,
) *routeError {
	if transportErr != nil {
		if failure, err := attemptfailure.NewTransport(transportErr); err == nil {
			_, _ = handler.attempts.RecordFailure(ctx, route, observation, failure)
		}
	}
	return newRouteError(
		http.StatusBadGateway, "chat_upstream_unavailable", "上游暂时不可用", nil,
	)
}

// recordHTTPFailure 记录上游 HTTP 失败并给出换号建议。
func (handler *Handler) recordHTTPFailure(
	ctx context.Context,
	provider relaycore.Provider,
	route runtimecore.ModelRoute,
	observation accountcredentials.CredentialObservation,
	response *http.Response,
) (*routeError, bool) {
	prefix, readErr := io.ReadAll(io.LimitReader(response.Body, sharedfailure.MaxErrorPayloadBytes+1))
	closeResponseBody(response)
	status := response.StatusCode
	// 上游 401/403 是「这个账号对这个上游无效」，不是「本机调用方没登录」。
	// 原样返回会把 WebUI 踢回登录页，所以统一折成 502。
	if status < http.StatusBadRequest ||
		status > 599 ||
		status == http.StatusUnauthorized ||
		status == http.StatusForbidden {
		status = http.StatusBadGateway
	}
	retry := response.StatusCode == http.StatusTooManyRequests ||
		response.StatusCode >= http.StatusInternalServerError
	if readErr == nil {
		classification, err := provider.ClassifyFailure(
			response.StatusCode, response.Header, prefix, handler.clock(),
		)
		if err == nil {
			if failure, buildErr := attemptfailure.New(classification); buildErr == nil {
				_, _ = handler.attempts.RecordFailure(ctx, route, observation, failure)
			}
			retry = retryableKind(classification.Kind())
			if classification.Kind() == runtimecore.FailureUpstreamEdgeRejected {
				// 站点边缘拒绝与账号无关：交给前端一个明确的网关错误，不要透传拦截页。
				return newRouteError(
					http.StatusBadGateway, "chat_upstream_edge_rejected",
					"上游站点边缘拒绝了本次请求（与账号无关）", nil,
				), false
			}
		}
	}
	return newRouteError(
		status, "chat_upstream_error", upstreamErrorMessage(prefix, response.StatusCode), nil,
	), retry
}

// recordStreamFailure 记录上游流上的失败，并给出提交前的路由错误。
//
// 提交之后调用方会忽略返回值：那时能交付的只有 turn.failed 事件。
func (handler *Handler) recordStreamFailure(
	ctx context.Context,
	route runtimecore.ModelRoute,
	observation accountcredentials.CredentialObservation,
	failure error,
) *routeError {
	detail := streamFailureDetail(failure)
	if failure != nil {
		if attempt, err := attemptfailure.NewIncompleteStream(failure); err == nil {
			_, _ = handler.attempts.RecordFailure(ctx, route, observation, attempt)
		}
	}
	return newRouteError(http.StatusBadGateway, detail.Code, detail.Message, nil)
}

// recordUsage 结算一次请求的真实用量。
//
// 用量是事实：客户端断开不该让它消失，所以用 WithoutCancel 的上下文写库，
// 失败只影响统计，不影响客户端已经收到的内容。
func (handler *Handler) recordUsage(ctx context.Context, call *upstreamCall) {
	if handler.usage == nil || !call.hasUsage || !call.usage.IsValid() {
		return
	}
	_ = handler.usage.RecordAttemptUsage(context.WithoutCancel(ctx), call.route, call.usage)
}

// retryableKind 判断该失败是否值得换账号重试，与 relaycore 的同一张表保持一致。
func retryableKind(kind runtimecore.FailureKind) bool {
	switch kind {
	case runtimecore.FailureRateLimited,
		runtimecore.FailureUpstreamUnavailable,
		runtimecore.FailureRequestTimeout,
		runtimecore.FailureCredentialRejected:
		return true
	default:
		return false
	}
}

// streamFailureDetail 生成可以交付给前端的失败描述。
func streamFailureDetail(failure error) failureDetail {
	var upstream *upstreamError
	if errors.As(failure, &upstream) {
		return failureDetail{Code: upstream.Code, Message: sanitizeMessage(upstream.Message)}
	}
	if errors.Is(failure, context.Canceled) {
		return failureDetail{Code: "chat_turn_cancelled", Message: "本轮已被取消"}
	}
	return failureDetail{Code: "chat_upstream_stream_failed", Message: "上游流中断"}
}

// upstreamErrorMessage 从上游错误体里取一条可展示的文案。
//
// 只取 error.message，不透传整个响应体：错误体里可能带请求回显与内部地址，
// 而客户端真正需要的是「为什么失败」。
func upstreamErrorMessage(body []byte, status int) string {
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	var document map[string]any
	if err := decoder.Decode(&document); err == nil {
		if object, ok := document["error"].(map[string]any); ok {
			if message := sanitizeMessage(objectMessage(object)); message != "" {
				return message
			}
		}
	}
	return fmt.Sprintf("上游返回 HTTP %d", status)
}

// sanitizeMessage 去掉控制字符并把长度压到与 Node sanitizeDiagnosticText 相同的上限。
func sanitizeMessage(value string) string {
	cleaned := strings.Map(func(character rune) rune {
		if character < 0x20 || character == 0x7f {
			return ' '
		}
		return character
	}, value)
	cleaned = strings.Join(strings.Fields(cleaned), " ")
	if len(cleaned) > maxFailureMessageLength {
		cleaned = cleaned[:maxFailureMessageLength-3] + "..."
	}
	return cleaned
}

// isEventStream 判断上游是否按 SSE 交付。
func isEventStream(header http.Header) bool {
	return strings.Contains(strings.ToLower(header.Get("Content-Type")), "text/event-stream")
}

// closeResponseBody 关闭上游响应体，错误无意义（连接已经不可用）。
func closeResponseBody(response *http.Response) {
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
}

// routeError 是一次请求失败的路由级结论。
type routeError struct {
	Status  int
	Code    string
	Message string
	Details any
}

func newRouteError(status int, code string, message string, details any) *routeError {
	return &routeError{Status: status, Code: code, Message: message, Details: details}
}

// routeErrorBody 与 Node writeError 的响应体逐字段一致：ok / error / message / details。
type routeErrorBody struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message"`
	Details any    `json:"details,omitempty"`
}

// writeRouteError 交付路由级错误（尚未写过任何 SSE 字节时才允许调用）。
func writeRouteError(response http.ResponseWriter, routeErr *routeError) {
	status := routeErr.Status
	if status < 400 || status > 599 {
		status = http.StatusInternalServerError
	}
	body, err := json.Marshal(routeErrorBody{
		OK:      false,
		Error:   routeErr.Code,
		Message: routeErr.Message,
		Details: routeErr.Details,
	})
	if err != nil {
		status = http.StatusInternalServerError
		body = []byte(`{"ok":false,"error":"chat_runtime_failed","message":"聊天请求失败"}`)
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_, _ = response.Write(body)
}

// matchCommandPath 从路径里取出会话标识：<prefix>{sessionId}/commands。
func matchCommandPath(path string, prefix string) (string, bool) {
	if !strings.HasPrefix(path, prefix) {
		return "", false
	}
	rest := strings.TrimPrefix(path, prefix)
	sessionPart, suffix, found := strings.Cut(rest, "/")
	if !found || suffix != "commands" || sessionPart == "" {
		return "", false
	}
	// Node 用 decodeURIComponent 解码会话标识，这里保持同样的语义。
	sessionID, err := url.PathUnescape(sessionPart)
	if err != nil || strings.TrimSpace(sessionID) == "" {
		return "", false
	}
	return sessionID, true
}

// readRequestBody 读取并限制请求体大小。
func readRequestBody(request *http.Request, limit int64) ([]byte, error) {
	if request.Body == nil {
		return nil, nil
	}
	document, err := io.ReadAll(io.LimitReader(request.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(document)) > limit {
		return nil, errors.New("请求体超过上限")
	}
	return document, nil
}

// newIdentifier 生成 `<prefix>-<uuid>` 形状的标识，与 Node idFactory 的默认实现同形。
func newIdentifier(prefix string) string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
	}
	// 按 RFC 4122 的 v4 布局置位，让标识与 crypto.randomUUID() 一样可被识别。
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return prefix + "-" + formatUUID(raw)
}

// formatUUID 把 16 字节渲染成 8-4-4-4-12 的连字符形式。
func formatUUID(raw [16]byte) string {
	encoded := hex.EncodeToString(raw[:])
	return strings.Join([]string{
		encoded[0:8], encoded[8:12], encoded[12:16], encoded[16:20], encoded[20:32],
	}, "-")
}
