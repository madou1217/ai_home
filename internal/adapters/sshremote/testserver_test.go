package sshremote

import (
	"bytes"
	"io"
	"net"
	"sync"
	"testing"

	"golang.org/x/crypto/ssh"
)

// testServerOptions 描述进程内 SSH server 的认证与 exec 行为。
type testServerOptions struct {
	HostKey       ssh.Signer
	Password      string
	AuthorizedKey ssh.PublicKey
	// Exec 返回远端退出码；stdout / stderr 直接写入会话通道。
	Exec func(command string, stdout, stderr io.Writer) uint32
}

// testServer 是本机回环上的最小 SSH server：只处理 session + exec，
// 用来覆盖真实握手、认证、known_hosts 与会话生命周期，不依赖外部 sshd。
type testServer struct {
	listener net.Listener
	config   *ssh.ServerConfig

	mutex       sync.Mutex
	connections []*ssh.ServerConn
	closed      bool
}

func startTestServer(t *testing.T, options testServerOptions) *testServer {
	t.Helper()
	hostKey := options.HostKey
	if hostKey == nil {
		hostKey = newTestSigner(t)
	}
	config := &ssh.ServerConfig{}
	config.AddHostKey(hostKey)
	if options.Password != "" {
		password := options.Password
		config.PasswordCallback = func(_ ssh.ConnMetadata, supplied []byte) (*ssh.Permissions, error) {
			if string(supplied) == password {
				return nil, nil
			}
			return nil, errTestAuthentication
		}
	}
	if options.AuthorizedKey != nil {
		authorized := options.AuthorizedKey.Marshal()
		config.PublicKeyCallback = func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if bytes.Equal(key.Marshal(), authorized) {
				return nil, nil
			}
			return nil, errTestAuthentication
		}
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("启动测试 SSH server 失败: %v", err)
	}
	server := &testServer{listener: listener, config: config}
	go server.serve(options.Exec)
	t.Cleanup(server.Close)
	return server
}

func (server *testServer) serve(exec func(string, io.Writer, io.Writer) uint32) {
	for {
		connection, err := server.listener.Accept()
		if err != nil {
			return
		}
		go server.handle(connection, exec)
	}
}

func (server *testServer) handle(raw net.Conn, exec func(string, io.Writer, io.Writer) uint32) {
	connection, channels, requests, err := ssh.NewServerConn(raw, server.config)
	if err != nil {
		_ = raw.Close()
		return
	}
	server.mutex.Lock()
	if server.closed {
		server.mutex.Unlock()
		_ = connection.Close()
		return
	}
	server.connections = append(server.connections, connection)
	server.mutex.Unlock()
	defer connection.Close()
	go ssh.DiscardRequests(requests)

	for newChannel := range channels {
		if newChannel.ChannelType() != "session" {
			_ = newChannel.Reject(ssh.UnknownChannelType, "only session channels are supported")
			continue
		}
		channel, channelRequests, err := newChannel.Accept()
		if err != nil {
			continue
		}
		go func() {
			defer channel.Close()
			for request := range channelRequests {
				if request.Type != "exec" {
					_ = request.Reply(false, nil)
					continue
				}
				var payload struct{ Command string }
				if err := ssh.Unmarshal(request.Payload, &payload); err != nil {
					_ = request.Reply(false, nil)
					return
				}
				_ = request.Reply(true, nil)
				code := exec(payload.Command, channel, channel.Stderr())
				_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{code}))
				return
			}
		}()
	}
}

func (server *testServer) Close() {
	server.mutex.Lock()
	server.closed = true
	connections := server.connections
	server.connections = nil
	server.mutex.Unlock()
	_ = server.listener.Close()
	for _, connection := range connections {
		_ = connection.Close()
	}
}

// host 与 port 拆开返回；测试配置里分别传 Host / Port。
func (server *testServer) hostPort(t *testing.T) (string, int) {
	t.Helper()
	address, ok := server.listener.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatalf("测试 server 地址不是 TCP: %v", server.listener.Addr())
	}
	return "127.0.0.1", address.Port
}
