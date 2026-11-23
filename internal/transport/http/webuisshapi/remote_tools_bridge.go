package webuisshapi

// 共享 MCP 桥：多个会话共用一个 daemon，会话侧只保留轻量 shim。
//
// 会话的 launch context 若含 bridgeSocket，__mcp-remote-tools 不再自己执行工具，
// 而是把 JSON-RPC 行转发给 daemon；daemon 用注册时收到的完整上下文执行调用。
// 工具执行实现与单会话桥完全相同（handleRemoteToolsMessage），因此语义不变。
//
// scope 由 config:server.mcpBridgeSharing 决定：global 一个 socket，workspace
// 每个工作区一个 socket，off 不启用共享（每会话一个完整桥）。

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strings"
	"sync/atomic"
	"time"
)

// mcpBridgeIdleDefault 是最后一个会话断开后的空闲退出时间。
const mcpBridgeIdleDefault = 5 * time.Minute

const mcpBridgeDialTimeout = 2 * time.Second

type mcpBridgeRegistration struct {
	Type   string          `json:"type"`
	Token  string          `json:"token"`
	Launch json.RawMessage `json:"launch"`
}

// RunMCPBridgeDaemon 监听 socket 并为每个连接服务一个 launch context。
func RunMCPBridgeDaemon(socketPath string, idle time.Duration) error {
	if idle <= 0 {
		idle = mcpBridgeIdleDefault
	}
	listener, cleanup, err := listenMCPBridge(socketPath)
	if err != nil {
		return err
	}
	defer cleanup()

	var active atomic.Int64
	var lastActivity atomic.Int64
	lastActivity.Store(time.Now().UnixNano())
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if active.Load() > 0 {
					lastActivity.Store(time.Now().UnixNano())
					continue
				}
				idleFor := time.Since(time.Unix(0, lastActivity.Load()))
				if idleFor >= idle {
					_ = listener.Close()
					return
				}
			}
		}
	}()
	for {
		conn, err := listener.Accept()
		if err != nil {
			close(done)
			return nil
		}
		active.Add(1)
		lastActivity.Store(time.Now().UnixNano())
		go func() {
			defer active.Add(-1)
			lastActivity.Store(time.Now().UnixNano())
			serveMCPBridgeConn(conn)
		}()
	}
}

// serveMCPBridgeConn 读取注册行，然后把后续每个 JSON-RPC 行交给共享执行器。
func serveMCPBridgeConn(conn net.Conn) {
	defer func() { _ = conn.Close() }()
	reader := bufio.NewReaderSize(conn, 1<<20)
	registrationLine, err := reader.ReadBytes('\n')
	if err != nil {
		return
	}
	var registration mcpBridgeRegistration
	if json.Unmarshal(bytes.TrimSpace(registrationLine), &registration) != nil || registration.Type != "register" {
		return
	}
	var launch remoteToolsLaunchContext
	if json.Unmarshal(registration.Launch, &launch) != nil {
		return
	}
	launch = normalizeRemoteToolsLaunchContext(launch)
	writer := bufio.NewWriter(conn)
	defer func() { _ = writer.Flush() }()
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var message map[string]any
		if json.Unmarshal(line, &message) != nil {
			continue
		}
		reply := handleRemoteToolsMessage(message, launch)
		if reply == nil {
			continue
		}
		encoded, err := json.Marshal(reply)
		if err != nil {
			continue
		}
		if _, err := writer.Write(append(encoded, '\n')); err != nil {
			return
		}
		if err := writer.Flush(); err != nil {
			return
		}
	}
}

// runRemoteToolsShim 把本进程降级成共享桥的薄客户端（同二进制兜底路径）。
func runRemoteToolsShim(launch remoteToolsLaunchContext, stdin io.Reader, stdout io.Writer) error {
	conn, err := dialMCPBridge(launch.BridgeSocket, mcpBridgeDialTimeout)
	if err != nil {
		return fmt.Errorf("MCP 共享桥不可用: %w", err)
	}
	defer func() { _ = conn.Close() }()
	rawLaunch, err := json.Marshal(launch)
	if err != nil {
		return err
	}
	registration, err := json.Marshal(mcpBridgeRegistration{
		Type:   "register",
		Token:  launch.SessionToken,
		Launch: rawLaunch,
	})
	if err != nil {
		return err
	}
	if _, err := conn.Write(append(registration, '\n')); err != nil {
		return err
	}
	go func() { _, _ = io.Copy(stdout, conn) }()
	_, err = io.Copy(conn, stdin)
	return err
}

// ensureMCPBridge returns a live socket and a per-session token, or ok=false so
// the caller falls back to the per-session bridge.
func ensureMCPBridge(aiHomeDir, workspaceID, mode string) (socketPath, sessionToken string, ok bool) {
	if !mcpBridgeSupported() || strings.TrimSpace(mode) == "off" {
		return "", "", false
	}
	socketPath = mcpBridgeSocketPath(aiHomeDir, workspaceID, mode)
	if socketPath == "" {
		return "", "", false
	}
	if conn, err := dialMCPBridge(socketPath, 300*time.Millisecond); err == nil {
		_ = conn.Close()
	} else {
		if err := startMCPBridgeDaemon(aiHomeDir, socketPath); err != nil {
			return "", "", false
		}
		deadline := time.Now().Add(3 * time.Second)
		for {
			conn, dialErr := dialMCPBridge(socketPath, 300*time.Millisecond)
			if dialErr == nil {
				_ = conn.Close()
				break
			}
			if time.Now().After(deadline) {
				return "", "", false
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	return socketPath, randomHex(16), true
}
