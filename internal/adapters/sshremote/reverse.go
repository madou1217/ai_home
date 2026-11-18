package sshremote

import (
	"context"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
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
	if remotePort != 0 && (remotePort < 1024 || remotePort > 65535) {
		return nil, newError(CodeInvalidConfig, "反向隧道远端端口必须为 0（自动分配）或在 1024-65535", nil)
	}
	if localPort < 1 || localPort > 65535 {
		return nil, newError(CodeInvalidConfig, "反向隧道本机端口必须在 1-65535", nil)
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	client, err := Dial(ctx, config, 0)
	if err != nil {
		return nil, err
	}
	if remotePort == 0 {
		// x/crypto 对 OpenSSH < 6 会猜测固定端口；自动模式必须由 sshd 原子分配。
		_, version, openSSH := strings.Cut(string(client.client.ServerVersion()), "OpenSSH_")
		if openSSH {
			major, _, _ := strings.Cut(version, ".")
			number, parseErr := strconv.Atoi(major)
			if parseErr != nil || number < 6 {
				_ = client.Close()
				return nil, newError("tunnel_forward_refused", "远端 OpenSSH 版本不支持安全自动分配反向隧道端口", nil)
			}
		}
	}
	// tcpip-forward 没有 context 参数；取消时关闭本隧道的独立 SSH 连接。
	stop := context.AfterFunc(ctx, func() { _ = client.Close() })
	defer stop()
	listener, err := client.client.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", remotePort))
	if err != nil {
		_ = client.Close()
		return nil, newError("tunnel_forward_refused", "远端拒绝反向转发（端口被占用或不允许 AllowTcpForwarding）", err)
	}
	if !stop() || ctx.Err() != nil {
		_ = client.Close()
		return nil, ctx.Err()
	}
	address, ok := listener.Addr().(*net.TCPAddr)
	if !ok || address.Port < 1 || address.Port > 65535 {
		_ = client.Close()
		return nil, newError("tunnel_forward_refused", "远端未返回有效的反向隧道端口", nil)
	}
	tunnel := &ReverseTunnel{
		client:     client,
		listener:   listener,
		remotePort: address.Port,
		localPort:  localPort,
		active:     make(map[net.Conn]struct{}),
		done:       make(chan struct{}),
	}
	go tunnel.acceptLoop(listener)
	go func() {
		_ = client.client.Wait()
		tunnel.markDone()
	}()
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
			if !closed && current == listener {
				tunnel.markDone()
			}
			return
		}
		go tunnel.forward(connection)
	}
}

func (tunnel *ReverseTunnel) forward(remote net.Conn) {
	local, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(tunnel.localPort), 10*time.Second)
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
	defer func() {
		_ = remote.Close()
		_ = local.Close()
		tunnel.mutex.Lock()
		delete(tunnel.active, remote)
		delete(tunnel.active, local)
		tunnel.mutex.Unlock()
	}()
	finished := make(chan struct{}, 1)
	go func() {
		pipeAndClose(remote, local)
		finished <- struct{}{}
	}()
	pipeAndClose(local, remote)
	<-finished
}

func pipeAndClose(destination net.Conn, source net.Conn) {
	_, err := io.Copy(destination, source)
	if closer, ok := destination.(interface{ CloseWrite() error }); ok && err == nil {
		_ = closer.CloseWrite()
	} else {
		_ = destination.Close()
		_ = source.Close()
	}
}

// BoundRemotePort 返回 sshd 原子分配的端口（不是配置中的 0）。
func (tunnel *ReverseTunnel) BoundRemotePort() int {
	if tunnel == nil {
		return 0
	}
	return tunnel.remotePort
}

// Probe 只检查这条 SSH 连接是否仍可响应，绝不重新绑定或占用其它监听。
// 不支持 keepalive 的服务端可以回复 false；收到回复本身就证明连接存活。
func (tunnel *ReverseTunnel) Probe(ctx context.Context) error {
	if tunnel == nil {
		return newError(CodeDialFailed, "反向隧道未建立", nil)
	}
	select {
	case <-tunnel.Done():
		return newError("tunnel_closed", "反向隧道已关闭", nil)
	default:
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		_, _, err := tunnel.client.client.SendRequest("keepalive@openssh.com", true, nil)
		result <- err
	}()
	select {
	case err := <-result:
		if err != nil {
			_ = tunnel.Close()
			return newError("tunnel_probe_failed", "反向隧道探活失败", err)
		}
		return nil
	case <-ctx.Done():
		_ = tunnel.Close()
		return newError("tunnel_probe_failed", "反向隧道探活超时或取消", ctx.Err())
	}
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
	if tunnel.client != nil {
		_ = tunnel.client.Close()
	}
	if listener != nil {
		_ = listener.Close()
	}
	for _, connection := range active {
		_ = connection.Close()
	}
	tunnel.markDone()
	return nil
}

func (tunnel *ReverseTunnel) markDone() {
	tunnel.doneOnce.Do(func() { close(tunnel.done) })
}
