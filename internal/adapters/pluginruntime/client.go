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

// Client 是到 Plugin Host 的一条已认证连接，可并发调用。
type Client struct {
	conn      net.Conn
	writeMu   sync.Mutex
	mu        sync.Mutex
	pending   map[string]chan frame
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
	client := &Client{conn: conn, pending: make(map[string]chan frame), closed: make(chan struct{})}
	go client.readLoop()
	return client, nil
}

// Call 调用宿主方法。ctx 取消或到期时会给宿主发 cancel，让插件 handler 的 signal 真的 abort。
func (c *Client) Call(ctx context.Context, method string, value any, payload []byte) (Result, error) {
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
	replies := make(chan frame, 1)
	c.mu.Lock()
	if c.closeErr != nil {
		err := c.closeErr
		c.mu.Unlock()
		return Result{}, err
	}
	if len(c.pending) >= plugincontract.MaxInflightCalls {
		c.mu.Unlock()
		return Result{}, &Error{Code: plugincontract.CodeRpcInflightLimit}
	}
	c.pending[id] = replies
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
		if errors.Is(err, os.ErrDeadlineExceeded) {
			return Result{}, &Error{Code: plugincontract.CodeRpcTimeout, Message: "宿主未在期限内读取请求，连接已关闭"}
		}
		return Result{}, wrapTransport(err)
	}

	select {
	case reply := <-replies:
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
	if err != nil && errors.Is(err, os.ErrDeadlineExceeded) {
		c.shutdown(&Error{Code: plugincontract.CodeRpcClosed, Message: "写入超时，连接已关闭"})
	}
	return err
}

func (c *Client) forget(id string) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
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
		c.mu.Lock()
		replies, ok := c.pending[incoming.message.ID]
		delete(c.pending, incoming.message.ID)
		c.mu.Unlock()
		if ok {
			replies <- incoming
		}
	}
}

func (c *Client) shutdown(err error) {
	c.closeOnce.Do(func() {
		c.mu.Lock()
		c.closeErr = err
		c.mu.Unlock()
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
