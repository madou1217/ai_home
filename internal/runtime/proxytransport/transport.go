package proxytransport

import (
	"context"
	"io"
	"net"
)

const (
	// DefaultRemoteAddress 是远端 AIH 管理面的默认 loopback 地址。
	DefaultRemoteAddress = "127.0.0.1:9527"
	// DefaultListenAddress 是本地转发的默认监听地址；端口 0 由内核分配。
	DefaultListenAddress = "127.0.0.1:0"
)

// Transport 把远端 AIH 管理面映射成本机 loopback 入口。
//
// BaseURL 返回的 http://127.0.0.1:<port> 可以直接作为 AIH_SERVER_BASE_URL；
// Close 释放监听、在途连接与底层连接器，重复调用是安全的。
type Transport interface {
	BaseURL() string
	Close() error
}

// Dialer 打开一条到远端 loopback 地址的字节流。
//
// 接口刻意只暴露拨号：拿到 Dialer 无法执行远端命令，SSH 传输因此不可能触发
// 远端进程。*sshremote.Client 以 DialTCP 方法直接满足该接口。
type Dialer interface {
	DialTCP(ctx context.Context, network, address string) (net.Conn, error)
}

// Connector 是被传输层接管的 Dialer：Transport.Close 会调用一次 Close。
type Connector interface {
	Dialer
	io.Closer
}

// SSHOptions 配置 SSH 传输；零值使用默认 loopback 地址。
type SSHOptions struct {
	// RemoteAddress 是远端 AIH 管理面的 loopback host:port；空值用
	// DefaultRemoteAddress。
	RemoteAddress string
	// ListenAddress 是本地监听地址，必须是 loopback host:port；空值用
	// DefaultListenAddress。
	ListenAddress string
}
