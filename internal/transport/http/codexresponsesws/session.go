package codexresponsesws

import (
	"context"
	"errors"
	"net"
	"sync"

	"github.com/coder/websocket"
	"github.com/madou1217/ai_home/internal/adapters/codex/responseswebsocket"
)

// managedSession 绑定一对客户端/上游连接，并提供一次性取消语义。
type managedSession struct {
	mu       sync.Mutex
	ctx      context.Context
	cancel   context.CancelFunc
	client   responseswebsocket.Connection
	upstream responseswebsocket.Connection
	closed   bool
}

func newManagedSession(
	client responseswebsocket.Connection,
) *managedSession {
	ctx, cancel := context.WithCancel(context.Background())
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

// Client 返回客户端连接。
func (session *managedSession) Client() responseswebsocket.Connection {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.client
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
}

// pumpClientToUpstream 保持文本帧字节不变，并在写入前验证串行模型绑定。
func pumpClientToUpstream(
	session *managedSession,
	observer *turnObserver,
	results chan<- pumpResult,
) {
	client := session.Client()
	upstream := session.Upstream()
	for {
		messageType, payload, err := client.Read(session.Context())
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
		if err := observer.Begin(payload); err != nil {
			code := "invalid_response_create"
			message := "请求必须是同模型的串行 response.create"
			if errors.Is(err, ErrConcurrentTurn) {
				code = "concurrent_response_create"
				message = "同一 WebSocket 连接只允许串行请求"
			}
			writeWebSocketError(client, 400, code, message)
			results <- pumpResult{
				source:      pumpSourceClient,
				err:         err,
				closeCode:   websocket.StatusPolicyViolation,
				closeReason: "invalid response.create",
			}
			return
		}
		if err := writeMessage(
			session.Context(),
			upstream,
			messageType,
			payload,
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
	results chan<- pumpResult,
) {
	client := session.Client()
	upstream := session.Upstream()
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
		if err != nil {
			results <- pumpResult{
				source:      pumpSourceUpstream,
				err:         err,
				closeCode:   websocket.StatusInternalError,
				closeReason: "runtime observation failed",
			}
			return
		}
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
		if closeError.Code == websocket.StatusNormalClosure {
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
