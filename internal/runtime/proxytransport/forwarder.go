package proxytransport

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
)

// loopbackForwarder 是各连接器传输共用的本地端口转发器：
// accept -> connector.DialTCP -> 双向 copy，并跟踪两端连接以便关闭。
//
// 它是未来 direct/tailscale/wireguard/relay 传输的复用点：只要提供
// Connector，新传输不需要重新实现连接跟踪与幂等关闭。
type loopbackForwarder struct {
	listener  net.Listener
	connector Connector
	remote    string
	cancel    context.CancelFunc
	once      sync.Once
	closeErr  error
	mu        sync.Mutex
	conns     map[net.Conn]struct{}
	closed    bool
	workers   sync.WaitGroup
}

func newForwarder(ctx context.Context, connector Connector, remoteAddress, listenAddress string) (*loopbackForwarder, error) {
	if connector == nil {
		return nil, errors.New("proxytransport: connector 不能为空")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if strings.TrimSpace(remoteAddress) == "" {
		remoteAddress = DefaultRemoteAddress
	}
	if strings.TrimSpace(listenAddress) == "" {
		listenAddress = DefaultListenAddress
	}
	remote, err := normalizeLoopbackAddress(remoteAddress, "远端管理面地址", false)
	if err != nil {
		return nil, err
	}
	listen, err := normalizeLoopbackAddress(listenAddress, "本地监听地址", true)
	if err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp", listen)
	if err != nil {
		return nil, fmt.Errorf("无法建立本地 loopback 转发监听: %w", err)
	}
	forwardCtx, cancel := context.WithCancel(ctx)
	forward := &loopbackForwarder{
		listener:  listener,
		connector: connector,
		remote:    remote,
		cancel:    cancel,
		conns:     map[net.Conn]struct{}{},
	}
	forward.workers.Add(1)
	go forward.acceptLoop(forwardCtx)
	return forward, nil
}

func (forward *loopbackForwarder) BaseURL() string {
	return "http://" + forward.listener.Addr().String()
}

// Close 取消在途拨号、关闭监听与所有被跟踪的连接，最后关闭连接器。
// 它必须等 accept 循环与每个转发 goroutine 退出后才返回，因此重复调用与
// 并发调用都只会关闭一次。
func (forward *loopbackForwarder) Close() error {
	if forward == nil {
		return nil
	}
	forward.once.Do(func() { forward.closeErr = forward.close() })
	return forward.closeErr
}

func (forward *loopbackForwarder) close() error {
	forward.cancel()
	var errs []error
	if err := forward.listener.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
		errs = append(errs, err)
	}
	forward.mu.Lock()
	forward.closed = true
	for conn := range forward.conns {
		_ = conn.Close()
	}
	forward.mu.Unlock()
	if err := forward.connector.Close(); err != nil {
		errs = append(errs, err)
	}
	forward.workers.Wait()
	return errors.Join(errs...)
}

func (forward *loopbackForwarder) acceptLoop(ctx context.Context) {
	defer forward.workers.Done()
	for {
		connection, err := forward.listener.Accept()
		if err != nil {
			return
		}
		if !forward.track(connection) {
			continue
		}
		forward.workers.Add(1)
		go func() {
			defer forward.workers.Done()
			defer forward.forget(connection)
			stream, dialErr := forward.connector.DialTCP(ctx, "tcp", forward.remote)
			if dialErr != nil {
				return
			}
			if !forward.track(stream) {
				_ = stream.Close()
				return
			}
			defer forward.forget(stream)
			relay(connection, stream)
		}()
	}
}

// relay 双向搬运字节；任一侧结束后关闭两端，避免半开连接悬挂。
func relay(local, remote net.Conn) {
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(remote, local)
		_ = remote.Close()
		close(done)
	}()
	_, _ = io.Copy(local, remote)
	_ = local.Close()
	_ = remote.Close()
	<-done
}

func (forward *loopbackForwarder) track(conn net.Conn) bool {
	forward.mu.Lock()
	defer forward.mu.Unlock()
	if forward.closed {
		_ = conn.Close()
		return false
	}
	forward.conns[conn] = struct{}{}
	return true
}

func (forward *loopbackForwarder) forget(conn net.Conn) {
	_ = conn.Close()
	forward.mu.Lock()
	delete(forward.conns, conn)
	forward.mu.Unlock()
}

// normalizeLoopbackAddress 校验并归一 host:port；host 只接受 localhost 与
// loopback IP，port 必须是数字。allowPortZero 仅对本地监听开放（内核分配）。
func normalizeLoopbackAddress(address, label string, allowPortZero bool) (string, error) {
	address = strings.TrimSpace(address)
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return "", fmt.Errorf("%s 必须是 loopback host:port: %w", label, err)
	}
	if strings.EqualFold(host, "localhost") {
		host = "localhost"
	} else {
		ip := net.ParseIP(strings.Trim(host, "[]"))
		if ip == nil || !ip.IsLoopback() {
			return "", fmt.Errorf("%s 只允许 loopback 地址", label)
		}
		host = ip.String()
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 0 || number > 65535 {
		return "", fmt.Errorf("%s 端口必须是 0-65535 的整数", label)
	}
	if !allowPortZero && number == 0 {
		return "", fmt.Errorf("%s 端口必须在 1-65535", label)
	}
	return net.JoinHostPort(host, strconv.Itoa(number)), nil
}
