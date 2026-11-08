// Package relaymux 把同一个 TCP 监听端口按首字节分流给 SOCKS5 与普通 HTTP/WebSocket/TLS。
//
// 原理与 Node 版 lib/server/relay-port-mux.js 一致：SOCKS5 问候恒以 0x05 开头，
// HTTP 请求行是 ASCII，TLS ClientHello 是 0x16，因此只看第一个字节即可判定归属。
// 分流必须无损：被 peek 的字节要回填给下游，否则 SOCKS 握手或 HTTP 请求会缺字节。
package relaymux

import (
	"errors"
	"io"
	"net"
	"sync"
	"time"
)

// firstByteSOCKS5 是 RFC 1928 的协议版本号，也是所有 SOCKS5 连接的首字节。
const firstByteSOCKS5 = 0x05

const (
	defaultPeekTimeout = 5 * time.Second
	defaultQueueDepth  = 128
)

var (
	// ErrMissingListener 表示没有提供源监听器。
	ErrMissingListener = errors.New("relaymux: 缺少源监听器")
	// ErrMissingHandler 表示没有提供 SOCKS5 处理器。
	ErrMissingHandler = errors.New("relaymux: 缺少 SOCKS5 处理器")
)

// ConnHandler 处理一条已判定为 SOCKS5 的连接。
// *socks5.Server 的 ServeConn 方法值可直接传入。
type ConnHandler func(conn net.Conn) error

// Config 是分流器配置。
type Config struct {
	Listener net.Listener
	Handler  ConnHandler
	// PeekTimeout 限制首字节到达时间；<=0 用默认 5s。
	PeekTimeout time.Duration
	// QueueDepth 限制等待上层 Accept 的非 SOCKS5 连接数；<=0 用默认 128。
	QueueDepth int
}

// Mux 同时实现 net.Listener（给 http.Server 提供非 SOCKS5 连接）与分流循环。
type Mux struct {
	listener    net.Listener
	handler     ConnHandler
	peekTimeout time.Duration
	other       *connListener
	closeOnce   sync.Once
}

// New 创建分流器；调用方随后在独立 goroutine 里跑 Dispatch，并把 Mux 交给 http.Server.Serve。
func New(config Config) (*Mux, error) {
	if config.Listener == nil {
		return nil, ErrMissingListener
	}
	if config.Handler == nil {
		return nil, ErrMissingHandler
	}
	timeout := config.PeekTimeout
	if timeout <= 0 {
		timeout = defaultPeekTimeout
	}
	depth := config.QueueDepth
	if depth <= 0 {
		depth = defaultQueueDepth
	}
	return &Mux{
		listener:    config.Listener,
		handler:     config.Handler,
		peekTimeout: timeout,
		other:       newConnListener(depth),
	}, nil
}

// Dispatch 跑分流循环，直到源 listener 关闭。
//
// 它只负责接收新连接并判定归属；非 SOCKS5 连接进入队列，由上层通过 Accept 取走。
func (mux *Mux) Dispatch() error {
	for {
		conn, err := mux.listener.Accept()
		if err != nil {
			mux.other.close()
			return err
		}
		go mux.route(conn)
	}
}

// route 读取首字节后把连接交给对应一侧；两层都要拿到被 peek 的那个字节。
func (mux *Mux) route(conn net.Conn) {
	wrapped, first, err := peekFirstByte(conn, mux.peekTimeout)
	if err != nil {
		_ = conn.Close()
		return
	}
	if first == firstByteSOCKS5 {
		_ = mux.handler(wrapped)
		return
	}
	if !mux.other.push(wrapped) {
		_ = wrapped.Close()
	}
}

// Accept 实现 net.Listener：只返回非 SOCKS5 的连接，交给 http.Server。
func (mux *Mux) Accept() (net.Conn, error) {
	return mux.other.accept()
}

// Addr 返回源监听器地址。
func (mux *Mux) Addr() net.Addr {
	if mux.listener == nil {
		return nil
	}
	return mux.listener.Addr()
}

// Close 关闭源监听器，并销毁队列里尚未被上层取走的连接。
func (mux *Mux) Close() error {
	var err error
	mux.closeOnce.Do(func() {
		mux.other.close()
		err = mux.listener.Close()
	})
	return err
}

var _ net.Listener = (*Mux)(nil)

// peekFirstByte 只读一个字节，再把它回填到返回的连接里。
func peekFirstByte(conn net.Conn, timeout time.Duration) (net.Conn, byte, error) {
	if timeout > 0 {
		if err := conn.SetReadDeadline(time.Now().Add(timeout)); err != nil {
			return nil, 0, err
		}
	}
	var first [1]byte
	if _, err := io.ReadFull(conn, first[:]); err != nil {
		return nil, 0, err
	}
	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		return nil, 0, err
	}
	return &replayConn{Conn: conn, pending: first[:]}, first[0], nil
}

// replayConn 把 peek 出来的字节放回读取流，语义与 Node 的 socket.unshift 相同。
type replayConn struct {
	net.Conn
	pending []byte
}

func (conn *replayConn) Read(p []byte) (int, error) {
	if len(conn.pending) > 0 {
		written := copy(p, conn.pending)
		conn.pending = conn.pending[written:]
		return written, nil
	}
	return conn.Conn.Read(p)
}

// CloseWrite 透传半关闭能力；http.Server 与服务端隧道都依赖它优雅收尾。
func (conn *replayConn) CloseWrite() error {
	if closer, ok := conn.Conn.(interface{ CloseWrite() error }); ok {
		return closer.CloseWrite()
	}
	return nil
}

// connListener 是给上限一个位置的连接队列：Accept 侧取走，push 侧投放。
// 队列满时 push 阻塞（形成对接收循环的反压），Close 会唤醒所有等待者并销毁存量连接。
type connListener struct {
	mu     sync.Mutex
	cond   *sync.Cond
	queue  []net.Conn
	depth  int
	closed bool
}

func newConnListener(depth int) *connListener {
	listener := &connListener{depth: depth}
	listener.cond = sync.NewCond(&listener.mu)
	return listener
}

func (listener *connListener) accept() (net.Conn, error) {
	listener.mu.Lock()
	defer listener.mu.Unlock()
	for len(listener.queue) == 0 && !listener.closed {
		listener.cond.Wait()
	}
	if len(listener.queue) == 0 {
		return nil, net.ErrClosed
	}
	conn := listener.queue[0]
	listener.queue[0] = nil
	listener.queue = listener.queue[1:]
	listener.cond.Signal()
	return conn, nil
}

func (listener *connListener) push(conn net.Conn) bool {
	listener.mu.Lock()
	defer listener.mu.Unlock()
	for len(listener.queue) >= listener.depth && !listener.closed {
		listener.cond.Wait()
	}
	if listener.closed {
		return false
	}
	listener.queue = append(listener.queue, conn)
	listener.cond.Signal()
	return true
}

func (listener *connListener) close() {
	listener.mu.Lock()
	if listener.closed {
		listener.mu.Unlock()
		return
	}
	listener.closed = true
	pending := listener.queue
	listener.queue = nil
	listener.mu.Unlock()
	listener.cond.Broadcast()
	for _, conn := range pending {
		_ = conn.Close()
	}
}
