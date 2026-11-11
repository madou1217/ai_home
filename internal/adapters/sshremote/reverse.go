package sshremote

import (
	"context"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
)

// ReverseTunnelStats 是反向隧道的运行计数；只用于状态面，不参与调度。
type ReverseTunnelStats struct {
	Connections int64 `json:"connections"`
	Failed      int64 `json:"failed"`
	Rebounds    int64 `json:"rebounds"`
}

// ReverseTunnel 在远端回环上申请一个监听端口，把进来的 TCP 连接转发到本机目标端口。
//
// 远端只监听 127.0.0.1，不开公网端口；隧道本身不授予权限，远端仍需通过本机 sshd 认证。
type ReverseTunnel struct {
	client     *Client
	listener   net.Listener
	remotePort int
	localPort  int

	mutex    sync.Mutex
	closed   bool
	stats    ReverseTunnelStats
	active   map[net.Conn]struct{}
	done     chan struct{}
	doneOnce sync.Once
}

// OpenReverseTunnel 建立独立 SSH 连接并申请远端监听。
func OpenReverseTunnel(ctx context.Context, config Config, remotePort int, localPort int) (*ReverseTunnel, error) {
	if remotePort < 1024 || remotePort > 65535 {
		return nil, newError(CodeInvalidConfig, "反向隧道远端端口必须在 1024-65535", nil)
	}
	if localPort < 1 || localPort > 65535 {
		return nil, newError(CodeInvalidConfig, "反向隧道本机端口必须在 1-65535", nil)
	}
	client, err := Dial(ctx, config, 0)
	if err != nil {
		return nil, err
	}
	listener, err := client.client.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", remotePort))
	if err != nil {
		_ = client.Close()
		return nil, newError("tunnel_forward_refused", "远端拒绝反向转发（端口被占用或不允许 AllowTcpForwarding）", err)
	}
	tunnel := &ReverseTunnel{
		client:     client,
		listener:   listener,
		remotePort: remotePort,
		localPort:  localPort,
		active:     make(map[net.Conn]struct{}),
		done:       make(chan struct{}),
	}
	go tunnel.acceptLoop(listener)
	return tunnel, nil
}

func (tunnel *ReverseTunnel) acceptLoop(listener net.Listener) {
	for {
		connection, err := listener.Accept()
		if err != nil {
			tunnel.mutex.Lock()
			current := tunnel.listener
			closed := tunnel.closed
			tunnel.mutex.Unlock()
			// Probe 替换 listener 时旧 acceptLoop 会退出，不能把新隧道标成断开。
			if !closed && current == listener {
				tunnel.markDone()
			}
			return
		}
		go tunnel.forward(connection)
	}
}

func (tunnel *ReverseTunnel) forward(remote net.Conn) {
	local, err := net.Dial("tcp", "127.0.0.1:"+strconv.Itoa(tunnel.localPort))
	if err != nil {
		tunnel.mutex.Lock()
		tunnel.stats.Failed++
		tunnel.mutex.Unlock()
		_ = remote.Close()
		return
	}
	tunnel.mutex.Lock()
	if tunnel.closed {
		tunnel.mutex.Unlock()
		_ = remote.Close()
		_ = local.Close()
		return
	}
	tunnel.stats.Connections++
	tunnel.active[remote] = struct{}{}
	tunnel.active[local] = struct{}{}
	tunnel.mutex.Unlock()
	go pipeAndClose(remote, local)
	go pipeAndClose(local, remote)
}

func pipeAndClose(destination net.Conn, source net.Conn) {
	_, _ = io.Copy(destination, source)
	if tcp, ok := destination.(*net.TCPConn); ok {
		_ = tcp.CloseWrite()
	}
	_ = source.Close()
}

// Probe 再次申请同一远端端口：bind-taken 表示原监听仍健康；成功表示之前已丢失，
// 采用新 listener 并计一次 rebound。
func (tunnel *ReverseTunnel) Probe(ctx context.Context) error {
	if tunnel == nil {
		return newError(CodeDialFailed, "反向隧道未建立", nil)
	}
	listener, err := tunnel.client.client.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", tunnel.remotePort))
	if err != nil {
		if isBindTaken(err) {
			return nil
		}
		return newError("tunnel_probe_failed", "反向隧道探活失败", err)
	}
	tunnel.mutex.Lock()
	if tunnel.closed {
		tunnel.mutex.Unlock()
		_ = listener.Close()
		return newError("tunnel_closed", "反向隧道已关闭", nil)
	}
	old := tunnel.listener
	tunnel.listener = listener
	tunnel.stats.Rebounds++
	tunnel.mutex.Unlock()
	if old != nil {
		_ = old.Close()
	}
	go tunnel.acceptLoop(listener)
	return nil
}

func isBindTaken(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "unable to bind") ||
		strings.Contains(message, "already in use") ||
		strings.Contains(message, "address already in use") ||
		// x/crypto 的 ssh.Client.Listen 对已占用端口统一返回 request denied；
		// 首连已成功，说明 AllowTcpForwarding 是开的，这里的拒绝视为端口仍被自己占着。
		strings.Contains(message, "request denied by peer")
}

// Done 在 SSH 连接断开/监听失败时关闭，供监督者退避重建。
func (tunnel *ReverseTunnel) Done() <-chan struct{} {
	if tunnel == nil {
		channel := make(chan struct{})
		close(channel)
		return channel
	}
	return tunnel.done
}

// Stats 返回当前计数快照。
func (tunnel *ReverseTunnel) Stats() ReverseTunnelStats {
	if tunnel == nil {
		return ReverseTunnelStats{}
	}
	tunnel.mutex.Lock()
	defer tunnel.mutex.Unlock()
	return tunnel.stats
}

// Close 关闭远端监听、SSH 连接与所有转发中的连接。
func (tunnel *ReverseTunnel) Close() error {
	if tunnel == nil {
		return nil
	}
	tunnel.mutex.Lock()
	if tunnel.closed {
		tunnel.mutex.Unlock()
		return nil
	}
	tunnel.closed = true
	listener := tunnel.listener
	active := make([]net.Conn, 0, len(tunnel.active))
	for connection := range tunnel.active {
		active = append(active, connection)
	}
	tunnel.active = nil
	tunnel.mutex.Unlock()
	if listener != nil {
		_ = listener.Close()
	}
	for _, connection := range active {
		_ = connection.Close()
	}
	if tunnel.client != nil {
		_ = tunnel.client.Close()
	}
	tunnel.markDone()
	return nil
}

func (tunnel *ReverseTunnel) markDone() {
	tunnel.doneOnce.Do(func() { close(tunnel.done) })
}
