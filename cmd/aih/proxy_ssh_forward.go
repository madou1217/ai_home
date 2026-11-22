package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/runtime/sshtunnel"
)

// sshLocalForward 通过已有 SSH 连接把远端 loopback 管理面映射到本机 loopback。
// 只负责传输，不接触 Management Key，也不启动远端命令。
type sshLocalForward struct {
	listener net.Listener
	client   *sshremote.Client
	remote   string
	cancel   context.CancelFunc
	once     sync.Once
	mu       sync.Mutex
	conns    map[net.Conn]struct{}
	closed   bool
	workers  sync.WaitGroup
}

func openSSHLocalForward(ctx context.Context, runtime commandRuntime, connectionID, listenAddress, remoteAddress string) (*sshLocalForward, error) {
	connectionID = strings.TrimSpace(connectionID)
	if connectionID == "" {
		return nil, errors.New("--ssh 需要连接 ID")
	}
	if err := requireLoopbackListenAddress(listenAddress); err != nil {
		return nil, err
	}
	if err := requireLoopbackListenAddress(remoteAddress); err != nil {
		return nil, errors.New("--ssh-remote-address 只允许 loopback host:port")
	}
	home, err := resolveAIHomeDir(runtime)
	if err != nil {
		return nil, err
	}
	databasePath, err := appstate.DatabasePath(home)
	if err != nil {
		return nil, err
	}
	raw, found, err := appstate.ReadKV(ctx, databasePath, "ssh_connections")
	if err != nil || !found {
		return nil, errors.New("本机没有可用的 SSH 连接记录")
	}
	var records []map[string]any
	if err := json.Unmarshal([]byte(raw), &records); err != nil {
		return nil, errors.New("SSH 连接记录不是合法 JSON")
	}
	byID := make(map[string]map[string]any, len(records))
	for _, record := range records {
		id, _ := record["id"].(string)
		if id = strings.TrimSpace(id); id != "" {
			byID[id] = record
		}
	}
	record, ok := byID[connectionID]
	if !ok {
		return nil, fmt.Errorf("SSH 连接 %s 不存在", connectionID)
	}
	hostHome, err := runtime.userHomeDir()
	if err != nil || strings.TrimSpace(hostHome) == "" {
		return nil, errors.New("无法解析本机用户目录")
	}
	config, err := sshtunnel.ConfigFromRecord(record, byID, hostHome)
	if err != nil {
		return nil, err
	}
	config = sshtunnel.ApplyHostKeys(config, readSSHKnownHosts(ctx, databasePath))
	client, err := sshremote.Dial(ctx, config, 15*time.Second)
	if err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp", listenAddress)
	if err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("无法建立本地 SSH 转发监听: %w", err)
	}
	forwardCtx, cancel := context.WithCancel(ctx)
	forward := &sshLocalForward{
		listener: listener, client: client, remote: strings.TrimSpace(remoteAddress),
		cancel: cancel, conns: make(map[net.Conn]struct{}),
	}
	forward.workers.Add(1)
	go func() {
		defer forward.workers.Done()
		for {
			connection, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			if !forward.track(connection) {
				continue
			}
			forward.workers.Add(1)
			go func() {
				defer forward.workers.Done()
				defer forward.forget(connection)
				stream, dialErr := client.DialTCP(forwardCtx, "tcp", forward.remote)
				if dialErr != nil {
					_ = connection.Close()
					return
				}
				if !forward.track(stream) {
					_ = stream.Close()
					return
				}
				defer forward.forget(stream)
				done := make(chan struct{})
				go func() {
					_, _ = io.Copy(stream, connection)
					_ = stream.Close()
					close(done)
				}()
				_, _ = io.Copy(connection, stream)
				_ = connection.Close()
				_ = stream.Close()
				<-done
			}()
		}
	}()
	return forward, nil
}

func (forward *sshLocalForward) URL() string {
	return "http://" + forward.listener.Addr().String()
}

func (forward *sshLocalForward) Close() error {
	if forward == nil {
		return nil
	}
	forward.once.Do(func() {
		forward.cancel()
		_ = forward.listener.Close()
		forward.mu.Lock()
		forward.closed = true
		for conn := range forward.conns {
			_ = conn.Close()
		}
		forward.mu.Unlock()
		_ = forward.client.Close()
		forward.workers.Wait()
	})
	return nil
}

func (forward *sshLocalForward) track(conn net.Conn) bool {
	forward.mu.Lock()
	defer forward.mu.Unlock()
	if forward.closed {
		_ = conn.Close()
		return false
	}
	forward.conns[conn] = struct{}{}
	return true
}

func (forward *sshLocalForward) forget(conn net.Conn) {
	_ = conn.Close()
	forward.mu.Lock()
	delete(forward.conns, conn)
	forward.mu.Unlock()
}

func readSSHKnownHosts(ctx context.Context, databasePath string) map[string]string {
	records := map[string]string{}
	raw, found, err := appstate.ReadKV(ctx, databasePath, "ssh_known_hosts")
	if err != nil || !found {
		return records
	}
	var stored map[string]struct {
		Fingerprint string `json:"fingerprint"`
	}
	if json.Unmarshal([]byte(raw), &stored) != nil {
		return records
	}
	for id, record := range stored {
		if value := strings.TrimSpace(record.Fingerprint); value != "" {
			records[strings.ToLower(id)] = value
		}
	}
	return records
}

func requireLoopbackListenAddress(address string) error {
	host, _, err := net.SplitHostPort(strings.TrimSpace(address))
	if err != nil {
		return errors.New("--listen 必须是 host:port")
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return errors.New("--listen 只允许 loopback 地址")
	}
	return nil
}
