package pluginruntime

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"sync"
	"time"

	plugincontract "github.com/madou1217/ai_home/contracts/plugins"
)

// cancel 帧很小，宿主正常时立即写完；宿主卡住时最多等这么久，避免取消路径本身挂住。
const cancelWriteGrace = 100 * time.Millisecond

// Result 是一次调用的返回：JSON 值 + 可选二进制 payload。
type Result struct {
	Value   json.RawMessage
	Payload []byte
}

// DialOptions 控制握手。ProtocolVersion 为 0 时使用合同当前版本（测试用它模拟不兼容的对端）。
type DialOptions struct {
	Token            string
	ProtocolVersion  uint32
	HandshakeTimeout time.Duration
}

// CallOptions 控制单次调用。
//
// OnCall 处理宿主在该调用进行中的反向调用（协议 v2 的 call 帧，例如 gateway.attempt 的 next()）。
// 只有这一个调用名下的反向调用会交给它；父调用结束（结果、错误、取消、超时、断开）时，
// 挂在它下面的反向调用一律取消。为 nil 时该调用名下的反向调用一律回 method_unknown。
type CallOptions struct {
	OnCall func(ctx context.Context, method string, value json.RawMessage) (any, error)
}

// pendingCall 是一次在途调用的状态；children 是它名下正在处理的反向调用数。
//
// parked 的父调用不占 inflightCalls：中间件停在 next() 等上游首字节时可能挂很久，
// 用 inflight 名额会让其他短调用被拒（与 Node lib/plugins/transport/rpc-client.js 同口径）。
type pendingCall struct {
	replies  chan frame
	ctx      context.Context
	onCall   func(ctx context.Context, method string, value json.RawMessage) (any, error)
	cancel   context.CancelFunc
	children int
}

// Client 是到 Plugin Host 的一条已认证连接，可并发调用。
type Client struct {
	conn      net.Conn
	writeMu   sync.Mutex
	mu        sync.Mutex
	pending   map[string]*pendingCall
	parked    int
	closed    chan struct{}
	closeErr  error
	closeOnce sync.Once
}

// Dial 连接宿主并完成握手；版本不兼容返回带支持范围的 plugin_rpc_incompatible。
func Dial(ctx context.Context, address string, options DialOptions) (*Client, error) {
	conn, err := dialHost(ctx, address)
	if err != nil {
		return nil, &Error{Code: plugincontract.CodeRpcClosed, Message: err.Error()}
	}
	timeout := options.HandshakeTimeout
	if timeout <= 0 {
		timeout = time.Duration(plugincontract.MaxHandshakeTimeoutMs) * time.Millisecond
	}
	_ = conn.SetDeadline(time.Now().Add(timeout))
	version := options.ProtocolVersion
	if version == 0 {
		version = plugincontract.ProtocolVersion
	}
	hello, err := encodeFrame(plugincontract.Message{Kind: plugincontract.KindHello, ProtocolVersion: version, ID: newID(), Token: options.Token}, nil)
	if err == nil {
		_, err = conn.Write(hello)
	}
	if err != nil {
		conn.Close()
		return nil, &Error{Code: plugincontract.CodeRpcClosed, Message: err.Error()}
	}
	reply, err := readFrame(conn)
	if err != nil {
		conn.Close()
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, &Error{Code: plugincontract.CodeRpcClosed, Message: "宿主在握手前关闭了连接"}
		}
		return nil, wrapTransport(err)
	}
	if reply.message.Kind != plugincontract.KindHelloResult {
		conn.Close()
		return nil, &Error{Code: plugincontract.CodeRpcInvalid, Message: "unexpected handshake reply " + reply.message.Kind}
	}
	if reply.message.Error != nil {
		conn.Close()
		return nil, &Error{Code: reply.message.Error.Code, Message: reply.message.Error.Message, Supported: reply.message.Supported}
	}
	_ = conn.SetDeadline(time.Time{})
	client := &Client{conn: conn, pending: make(map[string]*pendingCall), closed: make(chan struct{})}
	go client.readLoop()
	return client, nil
}

// Call 调用宿主方法。ctx 取消或到期时会给宿主发 cancel，让插件 handler 的 signal 真的 abort。
func (c *Client) Call(ctx context.Context, method string, value any, payload []byte) (Result, error) {
	return c.CallWith(ctx, method, value, payload, CallOptions{})
}

// CallWith 与 Call 相同，并允许本次调用接受宿主的反向调用（协议 v2）。
func (c *Client) CallWith(
	ctx context.Context,
	method string,
	value any,
	payload []byte,
	options CallOptions,
) (Result, error) {
	if len(payload) > plugincontract.MaxPayloadBytes {
		return Result{}, &Error{Code: plugincontract.CodeRpcPayloadLimit, Message: "payload exceeds contract limit"}
	}
	encodedValue, err := json.Marshal(value)
	if err != nil {
		return Result{}, err
	}
	if _, has := ctx.Deadline(); !has {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(plugincontract.MaxInvokeTimeoutMs)*time.Millisecond)
		defer cancel()
	}
	deadline, _ := ctx.Deadline()
	id := newID()
	callCtx, cancelCall := context.WithCancel(ctx)
	defer cancelCall()
	entry := &pendingCall{replies: make(chan frame, 1), ctx: callCtx, onCall: options.OnCall, cancel: cancelCall}
	c.mu.Lock()
	if c.closeErr != nil {
		err := c.closeErr
		c.mu.Unlock()
		return Result{}, err
	}
	if len(c.pending)-c.parked >= plugincontract.MaxInflightCalls {
		c.mu.Unlock()
		return Result{}, &Error{Code: plugincontract.CodeRpcInflightLimit}
	}
	c.pending[id] = entry
	c.mu.Unlock()

	request, err := encodeFrame(plugincontract.Message{
		Kind: plugincontract.KindCall, ProtocolVersion: plugincontract.ProtocolVersion, ID: id,
		Method: method, Deadline: deadline.UnixMilli(), Value: encodedValue,
	}, payload)
	if err == nil {
		err = c.writeBefore(request, deadline)
	}
	if err != nil {
		c.forget(id)
		if isTimeout(err) {
			return Result{}, &Error{Code: plugincontract.CodeRpcTimeout, Message: "宿主未在期限内读取请求，连接已关闭"}
		}
		return Result{}, wrapTransport(err)
	}

	select {
	case reply := <-entry.replies:
		if reply.message.Kind == plugincontract.KindError {
			fault := reply.message.Error
			if fault == nil {
				return Result{}, &Error{Code: "plugin_rpc_error"}
			}
			return Result{}, &Error{Code: fault.Code, Message: fault.Message}
		}
		return Result{Value: reply.message.Value, Payload: reply.payload}, nil
	case <-ctx.Done():
		c.forget(id)
		if cancel, err := encodeFrame(plugincontract.Message{Kind: plugincontract.KindCancel, ProtocolVersion: plugincontract.ProtocolVersion, ID: id}, nil); err == nil {
			_ = c.writeBefore(cancel, time.Now().Add(cancelWriteGrace))
		}
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return Result{}, &Error{Code: plugincontract.CodeRpcTimeout}
		}
		return Result{}, &Error{Code: plugincontract.CodeRpcCancelled}
	case <-c.closed:
		return Result{}, c.closeErr
	}
}

// Closed 报告连接是否已经关闭（宿主退出、写超时或主动关闭）；关闭后的客户端不能再用。
func (c *Client) Closed() bool {
	select {
	case <-c.closed:
		return true
	default:
		return false
	}
}

// Pending 返回在途调用数与其中挂着反向调用的父调用数（诊断用，不参与调用语义）。
func (c *Client) Pending() (pending int, parked int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.pending), c.parked
}

// Close 关闭连接，所有在途调用以 plugin_rpc_closed 结束。
func (c *Client) Close() error {
	c.shutdown(&Error{Code: plugincontract.CodeRpcClosed, Message: "client closed"})
	return nil
}

func (c *Client) write(data []byte) error {
	return c.writeBefore(data, time.Time{})
}

// writeBefore 在期限内把整帧写完。宿主卡住（例如插件占满 CPU）时它不读 socket，发送缓冲一满
// Write 就会阻塞且无视 ctx；所以写入必须带期限。期限到了帧可能只写了一半，字节流已无法对齐，
// 只能关闭整条连接（在途调用以 plugin_rpc_closed 结束）。
func (c *Client) writeBefore(data []byte, deadline time.Time) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_ = c.conn.SetWriteDeadline(deadline)
	_, err := c.conn.Write(data)
	if err != nil && isTimeout(err) {
		c.shutdown(&Error{Code: plugincontract.CodeRpcClosed, Message: "写入超时，连接已关闭"})
	}
	return err
}

// forget 移除在途调用，并取消挂在它下面的反向调用（父调用已经结束）。
func (c *Client) forget(id string) {
	c.mu.Lock()
	entry, ok := c.pending[id]
	delete(c.pending, id)
	if ok && entry.children > 0 {
		c.parked--
	}
	c.mu.Unlock()
	if ok && entry.cancel != nil {
		entry.cancel()
	}
}

// detachChild 注销一个已经处理完的反向调用（父调用可能已经被移除）。
func (c *Client) detachChild(parentID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.pending[parentID]
	if !ok || entry.children == 0 {
		return
	}
	entry.children--
	if entry.children == 0 {
		c.parked--
	}
}

func (c *Client) readLoop() {
	for {
		incoming, err := readFrame(c.conn)
		if err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, net.ErrClosed) {
				c.shutdown(&Error{Code: plugincontract.CodeRpcClosed, Message: "宿主连接已关闭"})
			} else {
				c.shutdown(wrapTransport(err))
			}
			return
		}
		// 宿主传输层出错（超限/畸形帧）时以 id=transport 告知原因后断开。
		if incoming.message.Kind == plugincontract.KindError && incoming.message.ID == "transport" && incoming.message.Error != nil {
			c.shutdown(&Error{Code: incoming.message.Error.Code, Message: incoming.message.Error.Message})
			return
		}
		// 宿主的反向调用（协议 v2）：只接受挂在仍在等待结果的父调用下面的调用，
		// 交给该父调用的 onCall；没有处理器、父调用已结束或超过挂起上限时回显式错误。
		if incoming.message.Kind == plugincontract.KindCall {
			go c.handleInbound(incoming.message)
			continue
		}
		if incoming.message.Kind == plugincontract.KindCancel {
			continue
		}
		c.mu.Lock()
		entry, ok := c.pending[incoming.message.ID]
		delete(c.pending, incoming.message.ID)
		if ok && entry.children > 0 {
			c.parked--
		}
		c.mu.Unlock()
		if ok {
			if entry.cancel != nil {
				entry.cancel()
			}
			entry.replies <- incoming
		}
	}
}

// handleInbound 处理宿主的反向调用：父调用必须在途，且该调用声明了 onCall。
//
// 反向调用的上下文随父调用结束而取消（Node 的 settlePending → abortChildren 同语义），
// 也受帧里的 deadline 约束；父调用结束时宿主本来也会取消它，这里保证 Go 侧同样停手。
func (c *Client) handleInbound(message plugincontract.Message) {
	c.mu.Lock()
	entry, ok := c.pending[message.Parent]
	if !ok {
		c.mu.Unlock()
		c.replyError(message.ID, plugincontract.CodeRpcParentUnknown, "父调用不存在或已结束")
		return
	}
	handler := entry.onCall
	parentCtx := entry.ctx
	if handler == nil {
		c.mu.Unlock()
		c.replyError(message.ID, plugincontract.CodeRpcMethodUnknown, "该调用不接受反向调用 "+message.Method)
		return
	}
	if entry.children == 0 && c.parked >= plugincontract.MaxParkedCalls {
		c.mu.Unlock()
		c.replyError(message.ID, plugincontract.CodeRpcInflightLimit, "挂起的反向调用过多")
		return
	}
	if entry.children == 0 {
		c.parked++
	}
	entry.children++
	c.mu.Unlock()
	defer c.detachChild(message.Parent)

	ctx, cancel := inboundContext(parentCtx, message.Deadline)
	defer cancel()
	value, err := handler(ctx, message.Method, message.Value)
	if err != nil {
		c.replyError(message.ID, inboundErrorCode(err), err.Error())
		return
	}
	c.replyResult(message.ID, value)
}

// inboundContext 让反向调用随父调用结束而取消，并受帧 deadline（缺省取调用超时上限）约束。
func inboundContext(parent context.Context, deadlineMs int64) (context.Context, context.CancelFunc) {
	if deadlineMs <= 0 {
		return context.WithTimeout(parent, time.Duration(plugincontract.MaxInvokeTimeoutMs)*time.Millisecond)
	}
	deadline := time.UnixMilli(deadlineMs)
	if deadline.Before(time.Now()) {
		deadline = time.Now()
	}
	return context.WithDeadline(parent, deadline)
}

func inboundErrorCode(err error) string {
	if code := Code(err); code != "" {
		return code
	}
	return "plugin_rpc_error"
}

func (c *Client) replyResult(id string, value any) {
	encoded, err := json.Marshal(value)
	if err != nil {
		c.replyError(id, plugincontract.CodeRpcInvalid, "反向调用返回值无法序列化")
		return
	}
	reply, err := encodeFrame(plugincontract.Message{
		Kind: plugincontract.KindResult, ProtocolVersion: plugincontract.ProtocolVersion, ID: id, Value: encoded,
	}, nil)
	if err == nil {
		_ = c.writeBefore(reply, time.Now().Add(cancelWriteGrace))
	}
}

func (c *Client) replyError(id string, code string, message string) {
	reply, err := encodeFrame(plugincontract.Message{
		Kind: plugincontract.KindError, ProtocolVersion: plugincontract.ProtocolVersion, ID: id,
		Error: &plugincontract.Fault{Code: code, Message: message},
	}, nil)
	if err == nil {
		_ = c.writeBefore(reply, time.Now().Add(cancelWriteGrace))
	}
}

func (c *Client) shutdown(err error) {
	c.closeOnce.Do(func() {
		c.mu.Lock()
		c.closeErr = err
		pending := make([]*pendingCall, 0, len(c.pending))
		for id, entry := range c.pending {
			pending = append(pending, entry)
			delete(c.pending, id)
		}
		c.parked = 0
		c.mu.Unlock()
		// 连接断开后挂在在途调用下面的反向调用也要停手，不然它们的 handler 会空等到 deadline。
		for _, entry := range pending {
			if entry.cancel != nil {
				entry.cancel()
			}
		}
		close(c.closed)
		_ = c.conn.Close()
	})
}

func wrapTransport(err error) error {
	var pluginErr *Error
	if errors.As(err, &pluginErr) {
		return pluginErr
	}
	return &Error{Code: plugincontract.CodeRpcClosed, Message: err.Error()}
}

func newID() string {
	var raw [16]byte
	_, _ = rand.Read(raw[:])
	return hex.EncodeToString(raw[:])
}

// 写超时的错误形态因平台而异：POSIX 是 os.ErrDeadlineExceeded，Windows named pipe（go-winio）
// 是它自己的 i/o timeout；两者都实现 net.Error.Timeout()。
func isTimeout(err error) bool {
	if errors.Is(err, os.ErrDeadlineExceeded) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}
