package codexenvironments

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/runtime/proxytransport"
)

// HostOptions 描述一条 url 模式宿主需要的事实。
type HostOptions struct {
	Connection Connection
	// RemoteAddress 是远端 exec-server 的 loopback host:port，例如 127.0.0.1:7788。
	RemoteAddress string
	// HomeDir 用于 ~ 展开与 known_hosts 定位。
	HomeDir string
	// ListenPort 是期望的本机监听端口。0 表示由系统分配（实际端口见 Host.LocalPort）。
	ListenPort int
	// BearerToken 非空时写进渲染结果，供 Codex 作为 token 使用。
	BearerToken string
	// Cwd 是远端默认工作目录，可空。
	Cwd string
}

// Host 是一条 url 模式环境的运行态：本地回环监听 + 经 SSH 的字节转发。
//
// 它解决的是 program 模式表达不了的三类连接：跳板需要专用私钥、密码认证、
// 以及任何 ProxyJump 无法逐跳指定选项的链路——因为这里由 AIH 自己完成多跳
// 拨号，每一跳都有完整凭据。
type Host struct {
	transport *proxytransport.SSH
	port      int
	entry     Entry
}

// DefaultRemoteExecServerAddress 是远端 exec-server 期望的 loopback 地址。
const DefaultRemoteExecServerAddress = "127.0.0.1:7788"

// OpenHost 建立通道宿主：在本机回环监听，并把流量经 SSH 转给远端 exec-server。
//
// 调用方必须保证远端已经运行 `codex exec-server --listen ws://127.0.0.1:7788`；
// 本函数只负责「把这一跳接上」，不负责在远端拉起进程。
func OpenHost(ctx context.Context, options HostOptions) (*Host, error) {
	if strings.TrimSpace(options.Connection.ID) == "" {
		return nil, errors.New("url 模式需要 SSH 连接 ID")
	}
	remote := strings.TrimSpace(options.RemoteAddress)
	if remote == "" {
		remote = DefaultRemoteExecServerAddress
	}
	config, err := toSSHConfig(options.Connection, options.HomeDir)
	if err != nil {
		return nil, err
	}
	client, err := sshremote.Dial(ctx, config, 0)
	if err != nil {
		return nil, err
	}
	// 连接断开后新拨号可以重建：监听端口不变，已建立的隧道不迁移。
	connector, err := proxytransport.NewReconnectingConnector(client, func(reconnectCtx context.Context) (proxytransport.Connector, error) {
		return sshremote.Dial(reconnectCtx, config, 0)
	})
	if err != nil {
		_ = client.Close()
		return nil, err
	}
	listen := "127.0.0.1:" + strconv.Itoa(options.ListenPort)
	transport, err := proxytransport.NewSSH(ctx, connector, proxytransport.SSHOptions{
		RemoteAddress: remote,
		ListenAddress: listen,
	})
	if err != nil {
		_ = connector.Close()
		return nil, err
	}
	port, err := portFromBaseURL(transport.BaseURL())
	if err != nil {
		_ = transport.Close()
		return nil, err
	}
	entry, rejection := BuildURLEntry(URLEnvironment{
		ConnectionID: options.Connection.ID,
		LocalPort:    port,
		BearerToken:  options.BearerToken,
		Cwd:          options.Cwd,
	})
	if rejection != nil {
		_ = transport.Close()
		return nil, errors.New(rejection.Message)
	}
	return &Host{transport: transport, port: port, entry: entry}, nil
}

// Entry 返回可直接渲染进 environments.toml 的条目（端口已填实际值）。
func (host *Host) Entry() Entry {
	if host == nil {
		return Entry{}
	}
	return host.entry
}

// LocalPort 是实际监听端口；ListenPort 传 0 时这里才是真实值。
func (host *Host) LocalPort() int {
	if host == nil {
		return 0
	}
	return host.port
}

// URL 是 Codex 应当连接的地址。
func (host *Host) URL() string {
	if host == nil {
		return ""
	}
	return host.entry.URL
}

// Close 释放监听、在途连接与 SSH 客户端；幂等。
func (host *Host) Close() error {
	if host == nil || host.transport == nil {
		return nil
	}
	return host.transport.Close()
}

func portFromBaseURL(baseURL string) (int, error) {
	trimmed := strings.TrimPrefix(strings.TrimSpace(baseURL), "http://")
	_, portText, err := net.SplitHostPort(trimmed)
	if err != nil {
		return 0, fmt.Errorf("无法解析通道宿主监听地址 %q: %w", baseURL, err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return 0, fmt.Errorf("通道宿主监听端口无效: %q", portText)
	}
	return port, nil
}
