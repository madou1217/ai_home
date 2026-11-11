package sshremote

import (
	"bufio"
	"context"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/madou1217/ai_home/internal/runtime/pty"
)

type ptyTestServer struct {
	listener net.Listener
	config   *ssh.ServerConfig
	mutex    sync.Mutex
	term     string
	cols     int
	rows     int
	winch    []pty.Size
}

func startPTYTestServer(t *testing.T) *ptyTestServer {
	t.Helper()
	server := &ptyTestServer{}
	server.config = &ssh.ServerConfig{
		PasswordCallback: func(_ ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
			if string(password) == "secret" {
				return nil, nil
			}
			return nil, errTestAuthentication
		},
	}
	server.config.AddHostKey(newTestSigner(t))
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	server.listener = listener
	go server.serve()
	t.Cleanup(func() { _ = listener.Close() })
	return server
}

func (server *ptyTestServer) serve() {
	for {
		connection, err := server.listener.Accept()
		if err != nil {
			return
		}
		go server.handle(connection)
	}
}

func (server *ptyTestServer) handle(raw net.Conn) {
	connection, channels, requests, err := ssh.NewServerConn(raw, server.config)
	if err != nil {
		_ = raw.Close()
		return
	}
	defer connection.Close()
	go ssh.DiscardRequests(requests)
	for newChannel := range channels {
		if newChannel.ChannelType() != "session" {
			_ = newChannel.Reject(ssh.UnknownChannelType, "session only")
			continue
		}
		channel, channelRequests, err := newChannel.Accept()
		if err != nil {
			continue
		}
		go server.handleSession(channel, channelRequests)
	}
}

func (server *ptyTestServer) handleSession(channel ssh.Channel, requests <-chan *ssh.Request) {
	defer channel.Close()
	started := false
	for request := range requests {
		switch request.Type {
		case "pty-req":
			var payload struct {
				Term string
				Cols uint32
				Rows uint32
				Rest []byte
			}
			_ = ssh.Unmarshal(request.Payload, &payload)
			server.mutex.Lock()
			server.term = payload.Term
			server.cols = int(payload.Cols)
			server.rows = int(payload.Rows)
			server.mutex.Unlock()
			_ = request.Reply(true, nil)
		case "window-change":
			var payload struct {
				Cols uint32
				Rows uint32
			}
			_ = ssh.Unmarshal(request.Payload, &payload)
			server.mutex.Lock()
			server.winch = append(server.winch, pty.Size{Cols: uint16(payload.Cols), Rows: uint16(payload.Rows)})
			server.mutex.Unlock()
			_ = request.Reply(true, nil)
		case "shell":
			_ = request.Reply(true, nil)
			if started {
				continue
			}
			started = true
			go func() {
				_, _ = io.WriteString(channel, "ready\r\n")
				reader := bufio.NewReader(channel)
				for {
					line, err := reader.ReadString('\n')
					if line != "" {
						_, _ = io.WriteString(channel, line)
					}
					if strings.Contains(line, "exit") {
						_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
						_ = channel.Close()
						return
					}
					if err != nil {
						return
					}
				}
			}()
		case "env":
			_ = request.Reply(true, nil)
		default:
			_ = request.Reply(false, nil)
		}
	}
}

func readUntil(t *testing.T, reader *bufio.Reader, marker string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		line, err := reader.ReadString('\n')
		if strings.Contains(line, marker) {
			return
		}
		if err != nil {
			t.Fatalf("read %q: %v (got %q)", marker, err, line)
		}
	}
	t.Fatalf("没有等到 %q", marker)
}

func TestOpenPTYRequestsPTYEchoesAndResizes(t *testing.T) {
	server := startPTYTestServer(t)
	host, port := splitHostPort(t, server.listener.Addr().String())
	session, err := OpenPTY(context.Background(), Config{
		Host: host, Port: port, User: "tester", AuthType: AuthPassword, Password: "secret",
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
	}, PTYOptions{Cols: 100, Rows: 30})
	if err != nil {
		t.Fatalf("OpenPTY: %v", err)
	}
	defer func() { _ = session.Close() }()
	reader := bufio.NewReader(session)
	readUntil(t, reader, "ready")
	server.mutex.Lock()
	if server.term != "xterm-256color" || server.cols != 100 || server.rows != 30 {
		t.Fatalf("pty request = term=%q cols=%d rows=%d", server.term, server.cols, server.rows)
	}
	server.mutex.Unlock()
	if _, err := session.Write([]byte("hello\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	readUntil(t, reader, "hello")
	if err := session.Resize(pty.Size{Cols: 120, Rows: 40}); err != nil {
		t.Fatalf("resize: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		server.mutex.Lock()
		changed := len(server.winch) > 0 && server.winch[len(server.winch)-1] == (pty.Size{Cols: 120, Rows: 40})
		server.mutex.Unlock()
		if changed {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	server.mutex.Lock()
	last := pty.Size{}
	if len(server.winch) > 0 {
		last = server.winch[len(server.winch)-1]
	}
	server.mutex.Unlock()
	if last != (pty.Size{Cols: 120, Rows: 40}) {
		t.Fatalf("window change = %+v", last)
	}
	if _, err := session.Write([]byte("exit\n")); err != nil {
		t.Fatalf("exit write: %v", err)
	}
	if err := session.Wait(); err != nil {
		t.Fatalf("Wait: %v", err)
	}
}

func TestOpenPTYCancelClosesSession(t *testing.T) {
	server := startPTYTestServer(t)
	host, port := splitHostPort(t, server.listener.Addr().String())
	ctx, cancel := context.WithCancel(context.Background())
	session, err := OpenPTY(ctx, Config{
		Host: host, Port: port, User: "tester", AuthType: AuthPassword, Password: "secret",
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
	}, PTYOptions{})
	if err != nil {
		t.Fatalf("OpenPTY: %v", err)
	}
	reader := bufio.NewReader(session)
	readUntil(t, reader, "ready")
	cancel()
	done := make(chan struct{})
	go func() { _ = session.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("取消后 Wait 没有返回")
	}
	_ = session.Close()
}

func splitHostPort(t *testing.T, address string) (string, int) {
	t.Helper()
	host, portText, err := net.SplitHostPort(address)
	if err != nil {
		t.Fatalf("split: %v", err)
	}
	port, err := net.LookupPort("tcp", portText)
	if err != nil {
		t.Fatalf("port: %v", err)
	}
	return host, port
}
