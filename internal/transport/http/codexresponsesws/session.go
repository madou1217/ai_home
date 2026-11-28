package codexresponsesws

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"strings"
	"sync"

	"github.com/coder/websocket"
	"github.com/madou1217/ai_home/core/requestid"
	"github.com/madou1217/ai_home/internal/adapters/codex/responseswebsocket"
	"github.com/madou1217/ai_home/internal/transport/http/codexwire"
)

// ErrClientCancelled 表示客户端用 response.cancel 主动结束了当前轮次。
// 它不是账号失败，不写运行态、不触发换号。
var ErrClientCancelled = errors.New("client cancelled response")

type clientFrame struct {
	messageType websocket.MessageType
	payload     []byte
}

// managedSession 绑定一对客户端/上游连接，并提供一次性取消语义。
type managedSession struct {
	mu       sync.Mutex
	ctx      context.Context
	cancel   context.CancelFunc
	client   responseswebsocket.Connection
	upstream responseswebsocket.Connection
	closed   bool
	// stripForeignReasoning：本会话上次由另一个账号服务，完整上下文里的加密推理需剥离。
	stripForeignReasoning bool
	// clientReaderStarted 在首次进入 429 握手等待时惰性启动唯一客户端读泵，
	// 以便在不取消 coder/websocket.Read 上下文的前提下即时感知客户端断开，同时
	// 保持正常 200 快路径零额外 goroutine 开销。
	clientReaderStarted bool
	clientFrames        chan clientFrame
	clientClosed        chan struct{}
	clientReadErr       error
}

func newManagedSession(
	client responseswebsocket.Connection,
	base context.Context,
) *managedSession {
	// 保留已鉴权请求上下文里的身份/统计作用域，但不继承它的取消信号：
	// hijack 后的连接生命周期由会话自己管理。
	if base == nil {
		base = context.Background()
	}
	ctx, cancel := context.WithCancel(context.WithoutCancel(base))
	return &managedSession{
		ctx:    ctx,
		cancel: cancel,
		client: client,
	}
}

// Context 返回不依赖被 hijack HTTP Request 的连接生命周期。
func (session *managedSession) Context() context.Context {
	return session.ctx
}

// SetUpstream 只允许设置一次，并处理 Server.Close 与建连完成的竞态。
func (session *managedSession) SetUpstream(
	upstream responseswebsocket.Connection,
) bool {
	if session == nil || upstream == nil {
		return false
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed || session.upstream != nil {
		return false
	}
	session.upstream = upstream
	return true
}

// ReplaceUpstream swaps a closed model-bound peer for a new one while the
// client WebSocket remains connected. Only the proxy's serialized switch path
// calls this method, so an in-flight old peer cannot overwrite the replacement.
func (session *managedSession) ReplaceUpstream(
	upstream responseswebsocket.Connection,
) bool {
	if session == nil || upstream == nil {
		return false
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed {
		return false
	}
	session.upstream = upstream
	return true
}

// Client 返回客户端连接。
func (session *managedSession) Client() responseswebsocket.Connection {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.client
}

// startClientReader 惰性启动绑定到会话全生命周期的客户端读协程。
//
// coder/websocket 取消 Read 的 ctx 会永久关闭连接，因此绝不对单次等待传入短 ctx；
// 该协程始终使用 session.Context() 读取，进入 429 等待时可即时感知客户端 Close/EOF
// 并唤醒取消，等待结束后 pumpClientToUpstream 通过 ReadClient 无缝承接后续帧。
func (session *managedSession) startClientReader() {
	if session == nil {
		return
	}
	session.mu.Lock()
	if session.clientReaderStarted || session.closed || session.client == nil {
		session.mu.Unlock()
		return
	}
	session.clientReaderStarted = true
	frames := make(chan clientFrame, 1)
	closed := make(chan struct{})
	session.clientFrames = frames
	session.clientClosed = closed
	client := session.client
	ctx := session.ctx
	session.mu.Unlock()

	go func() {
		for {
			messageType, payload, err := client.Read(ctx)
			if err != nil {
				session.mu.Lock()
				session.clientReadErr = err
				session.mu.Unlock()
				close(closed)
				return
			}
			select {
			case frames <- clientFrame{messageType: messageType, payload: payload}:
			case <-ctx.Done():
				session.mu.Lock()
				session.clientReadErr = ctx.Err()
				session.mu.Unlock()
				close(closed)
				return
			default:
				// The single bounded pending slot is already full (client pipelined
				// multiple unconsumed frames, violating the serial turn contract).
				// Never block this sole disconnect-detecting reader waiting to enqueue:
				// fail closed immediately, signal ClientClosed, and cancel the session
				// so any active 429 backoff wait aborts without retrying upstream.
				session.mu.Lock()
				session.clientReadErr = ErrConcurrentTurn
				session.mu.Unlock()
				close(closed)
				session.Cancel()
				return
			}
		}
	}()
}

// ClientClosed 返回客户端断开信号通道；未启动读协程时返回 nil。
func (session *managedSession) ClientClosed() <-chan struct{} {
	if session == nil {
		return nil
	}
	session.mu.Lock()
	closed := session.clientClosed
	session.mu.Unlock()
	return closed
}

// ClientReadErr 返回客户端读协程终止原因（正常断开、EOF 或并发帧溢出协议错误）。
func (session *managedSession) ClientReadErr() error {
	if session == nil {
		return nil
	}
	session.mu.Lock()
	err := session.clientReadErr
	session.mu.Unlock()
	return err
}

// ReadClient 在未启动读协程时直调 client.Read，已启动时从共享读通道无损承接。
func (session *managedSession) ReadClient(
	ctx context.Context,
) (websocket.MessageType, []byte, error) {
	if session == nil {
		return 0, nil, context.Canceled
	}
	session.mu.Lock()
	started := session.clientReaderStarted
	frames := session.clientFrames
	closed := session.clientClosed
	client := session.client
	session.mu.Unlock()
	if !started {
		return client.Read(ctx)
	}
	select {
	case frame := <-frames:
		return frame.messageType, frame.payload, nil
	default:
	}
	select {
	case frame := <-frames:
		return frame.messageType, frame.payload, nil
	case <-closed:
		select {
		case frame := <-frames:
			return frame.messageType, frame.payload, nil
		default:
		}
		session.mu.Lock()
		err := session.clientReadErr
		session.mu.Unlock()
		if err == nil {
			err = context.Canceled
		}
		return 0, nil, err
	case <-ctx.Done():
		return 0, nil, ctx.Err()
	}
}

// Upstream 返回已经建立的上游连接。
func (session *managedSession) Upstream() responseswebsocket.Connection {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.upstream
}

// Other 返回与结束方向相对的连接。
func (session *managedSession) Other(
	source pumpSource,
) responseswebsocket.Connection {
	if source == pumpSourceClient {
		return session.Upstream()
	}
	return session.Client()
}

// Cancel 解除两个泵的阻塞读取。
func (session *managedSession) Cancel() {
	if session != nil && session.cancel != nil {
		session.cancel()
	}
}

// Closing 判断结束是否由 Handler/Server 主动触发。
func (session *managedSession) Closing() bool {
	if session == nil {
		return true
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.closed
}

// CloseNow 幂等取消并立即关闭两个方向。
func (session *managedSession) CloseNow() error {
	if session == nil {
		return nil
	}
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return nil
	}
	session.closed = true
	client := session.client
	upstream := session.upstream
	session.mu.Unlock()
	session.Cancel()
	var closeErrors []error
	if upstream != nil {
		closeErrors = append(closeErrors, ignoreClosed(upstream.CloseNow()))
	}
	if client != nil {
		closeErrors = append(closeErrors, ignoreClosed(client.CloseNow()))
	}
	return errors.Join(closeErrors...)
}

// ignoreClosed 把并发泵已完成的连接视为幂等关闭成功。
func ignoreClosed(err error) error {
	if errors.Is(err, net.ErrClosed) {
		return nil
	}
	return err
}

type pumpSource uint8

const (
	pumpSourceClient pumpSource = iota + 1
	pumpSourceUpstream
)

type pumpResult struct {
	source           pumpSource
	err              error
	closeCode        websocket.StatusCode
	closeReason      string
	recordIncomplete bool
	// modelSwitch is set when a completed serial turn starts with another
	// model. The client socket stays open; the handler replaces the upstream
	// model-bound connection and replays this full frame.
	modelSwitch []byte
	model       string
}

// pumpClientToUpstream validates serial model binding, then applies the same
// outbound model/effort policy without clearing this peer's continuity.
func (handler *Handler) pumpClientToUpstream(
	session *managedSession,
	observer *turnObserver,
	turn *turnAdmission,
	results chan<- pumpResult,
) {
	client := session.Client()
	upstream := session.Upstream()
	for {
		messageType, payload, err := session.ReadClient(session.Context())
		if err != nil {
			results <- resultFromRead(pumpSourceClient, err, false)
			return
		}
		if messageType != websocket.MessageText {
			writeWebSocketError(
				client,
				400,
				"unsupported_frame_type",
				"只支持文本 response.create 帧",
			)
			results <- pumpResult{
				source:      pumpSourceClient,
				err:         ErrInvalidClientFrame,
				closeCode:   websocket.StatusUnsupportedData,
				closeReason: "text frames required",
			}
			return
		}
		// 非 response.create 帧（response.cancel、未知扩展）与上游共用同一套
		// Responses WS 协议；Node 旧实现原样转发，只标记不可重放。把它们当成
		// 非法请求会直接 400，客户端的取消/控制帧因此反复失败。
		if frameType := clientFrameType(payload); frameType != "" && frameType != "response.create" {
			log.Printf("codex responses ws control frame type=%s request_id=%s", frameType, requestid.FromContext(session.Context()))
			observer.MarkReplayUnavailable()
			// response.cancel：上游 native turn lane 在轮次运行中拒绝状态帧
			// （unsupported_native_inflight_message），转发只会把这个错误交给
			// 用户。取消的语义是停止本轮：直接结束两侧连接，让 Codex 用新的
			// 独立连接开始下一轮，而不是让用户看到上游的内部错误。
			if frameType == "response.cancel" {
				_ = client.Close(websocket.StatusNormalClosure, "cancelled")
				_ = upstream.Close(websocket.StatusNormalClosure, "cancelled")
				results <- pumpResult{
					source:      pumpSourceClient,
					err:         ErrClientCancelled,
					closeCode:   websocket.StatusNormalClosure,
					closeReason: "cancelled",
				}
				return
			}
			if err := writeMessage(session.Context(), upstream, messageType, payload); err != nil {
				results <- resultFromRead(pumpSourceUpstream, err, true)
				return
			}
			continue
		}
		if err := observer.Begin(payload); err != nil {
			if errors.Is(err, ErrModelChanged) {
				request, parseErr := parseClientFrame(payload)
				if parseErr == nil && request.Model != "" {
					results <- pumpResult{
						source:      pumpSourceClient,
						modelSwitch: append([]byte(nil), payload...),
						model:       request.Model,
					}
					return
				}
			}
			// 同一模型在跑时再来 response.create 属于 pipelining：Node 旧实现
			// 同样允许并原样转发，只是放弃重放关联。只有“运行中换模型”才是
			// 真正的并发请求，保留 concurrent_response_create。
			if errors.Is(err, ErrConcurrentTurn) {
				if request, parseErr := parseClientFrame(payload, observer.model); parseErr == nil && request.Model == observer.model {
					log.Printf("codex responses ws pipelined response.create request_id=%s", requestid.FromContext(session.Context()))
					observer.MarkReplayUnavailable()
					if writeErr := writeMessage(
						session.Context(),
						upstream,
						messageType,
						handler.prepareBoundClientFrame(payload, observer.model, observer.route.ModelID().String()),
					); writeErr != nil {
						results <- resultFromRead(pumpSourceUpstream, writeErr, true)
						return
					}
					continue
				}
				writeWebSocketError(client, 400, "concurrent_response_create", "同一 WebSocket 连接只允许串行请求")
				results <- pumpResult{
					source:      pumpSourceClient,
					err:         err,
					closeCode:   websocket.StatusPolicyViolation,
					closeReason: "concurrent response.create",
				}
				return
			}
			writeWebSocketError(client, 400, "invalid_response_create", "请求必须是同模型的串行 response.create")
			results <- pumpResult{
				source:      pumpSourceClient,
				err:         err,
				closeCode:   websocket.StatusPolicyViolation,
				closeReason: "invalid response.create",
			}
			return
		}
		// 每一轮（response.create）单独占一个并发名额。上一轮 response.completed
		// 时已在 upstream 泵归还，因此空闲连接不会长期占用容量；这里为新轮次重新获取。
		// 先显式释放再获取：Begin 成功已证明上一轮不再 active，但 upstream 泵的归还
		// 与这里的再次获取没有先后保证，先归还才能避免同一账号上限为 1 时被自己挡住。
		turn.release()
		lease, admitErr := handler.admitTurnForObserver(session.Context(), observer)
		if admitErr != nil {
			// 准入拒绝是瞬态容量事实，不是账号失败：不写冷却，只让客户端稍后重试。
			handler.writeAdmissionError(client, admitErr)
			results <- pumpResult{
				source:      pumpSourceClient,
				err:         admitErr,
				closeCode:   websocket.StatusPolicyViolation,
				closeReason: "admission rejected",
			}
			return
		}
		turn.set(lease)
		if session.stripForeignReasoning {
			payload = stripForeignReasoning(payload)
		}
		if err := writeMessage(
			session.Context(),
			upstream,
			messageType,
			handler.prepareBoundClientFrame(payload, observer.model, observer.route.ModelID().String()),
		); err != nil {
			results <- resultFromRead(pumpSourceUpstream, err, true)
			return
		}
	}
}

// pumpUpstreamToClient 先观察终态，再原样向客户端写入同一个文本帧。
func pumpUpstreamToClient(
	session *managedSession,
	observer *turnObserver,
	turn *turnAdmission,
	results chan<- pumpResult,
) {
	client := session.Client()
	upstream := session.Upstream()
	var held [][]byte
	for {
		messageType, payload, err := upstream.Read(session.Context())
		if err != nil {
			results <- resultFromRead(pumpSourceUpstream, err, true)
			return
		}
		if messageType != websocket.MessageText {
			_ = observer.RecordMalformedUpstream()
			results <- pumpResult{
				source:      pumpSourceUpstream,
				err:         ErrInvalidObserverState,
				closeCode:   websocket.StatusUnsupportedData,
				closeReason: "unexpected binary upstream frame",
			}
			return
		}
		terminal, err := observer.ObserveUpstream(payload)
		// 本轮结束即归还名额：response.completed 时连接仍可复用，必须在把终态
		// 交给客户端之前释放，否则下一轮会挡住自己（账号上限为 1 时尤其明显）。
		// 失败终态随后会关闭连接，defer 释放是幂等的。
		if observer.TakeTurnEnded() {
			turn.release()
		}
		if err != nil {
			results <- pumpResult{
				source:      pumpSourceUpstream,
				err:         err,
				closeCode:   websocket.StatusInternalError,
				closeReason: "runtime observation failed",
			}
			return
		}
		// 本轮尚未交出输出时的可重试失败：不转发错误，以 1011 关闭让 Codex 新开连接重选账号
		// （见 failover.go）。已扣留的预备帧一并丢弃。
		if terminal && observer.TakeRetryableFailover() && !observer.Committed() {
			held = nil
			results <- pumpResult{
				source:      pumpSourceUpstream,
				closeCode:   websocket.StatusInternalError,
				closeReason: retryableFailoverCloseReason,
			}
			return
		}
		if !terminal && !observer.Committed() && codexwire.IsPreambleEvent(payload, "") &&
			len(held) < maxHeldPreambleFrames {
			held = append(held, payload)
			continue
		}
		for _, frame := range held {
			if err := writeMessage(session.Context(), client, websocket.MessageText, frame); err != nil {
				results <- resultFromRead(pumpSourceClient, err, false)
				return
			}
		}
		held = nil
		observer.MarkCommitted()
		if err := writeMessage(
			session.Context(),
			client,
			messageType,
			payload,
		); err != nil {
			results <- resultFromRead(pumpSourceClient, err, false)
			return
		}
		if terminal {
			// 官方 Codex 客户端在失败或 incomplete 终态后丢弃当前
			// Responses WS；不能让客户端误以为还能安全复用这条连接。
			results <- pumpResult{
				source:           pumpSourceUpstream,
				closeCode:        websocket.StatusInternalError,
				closeReason:      "upstream response terminal",
				recordIncomplete: false,
			}
			return
		}
	}
}

// resultFromRead 提取可安全对称传播的 Close code/reason。
func resultFromRead(
	source pumpSource,
	err error,
	recordIncomplete bool,
) pumpResult {
	result := pumpResult{
		source:           source,
		err:              err,
		recordIncomplete: recordIncomplete,
	}
	var closeError websocket.CloseError
	if errors.As(err, &closeError) {
		result.closeCode = closeError.Code
		result.closeReason = closeError.Reason
		// 上游即便使用 1000 关闭，在真实生成请求尚未完成时仍是断流；
		// proxy 依据 observer.ActiveGenerating 区分完成后关闭与提前关闭。
		if source == pumpSourceClient && closeError.Code == websocket.StatusNormalClosure {
			result.recordIncomplete = false
		}
		return result
	}
	if source == pumpSourceClient {
		result.closeCode = websocket.StatusGoingAway
		result.closeReason = "client disconnected"
	} else {
		result.closeCode = websocket.StatusBadGateway
		result.closeReason = "upstream disconnected"
	}
	return result
}

// propagateClose 把一个方向收到的合法关闭语义传给另一个方向。
func propagateClose(
	result pumpResult,
	target responseswebsocket.Connection,
) {
	if target == nil {
		return
	}
	code := result.closeCode
	if code == websocket.StatusNoStatusRcvd ||
		code == websocket.StatusAbnormalClosure ||
		code == websocket.StatusTLSHandshake ||
		code == -1 {
		code = websocket.StatusGoingAway
	}
	_ = target.Close(code, result.closeReason)
}

// clientFrameType 返回客户端帧的 type；非 JSON 对象返回空串，交给后续校验拒绝。
// 非 response.create 的控制帧（response.cancel 等）与上游共用同一协议，必须转发。
func clientFrameType(payload []byte) string {
	var frame struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(payload, &frame) != nil {
		return ""
	}
	return strings.TrimSpace(frame.Type)
}
