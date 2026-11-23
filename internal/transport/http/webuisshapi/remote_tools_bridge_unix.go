//go:build !windows

package webuisshapi

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/madou1217/ai_home/application/serverconfig"
)

// mcpBridgeSocketPath maps the sharing mode to a stable socket path.
func mcpBridgeSocketPath(aiHomeDir, workspaceID, mode string) string {
	dir := filepath.Join(aiHomeDir, "run", "mcp-bridge")
	switch serverconfig.NormalizeMCPBridgeSharing(mode) {
	case serverconfig.MCPBridgeSharingWorkspace:
		key := "default"
		if workspaceID != "" {
			sum := sha256.Sum256([]byte(workspaceID))
			key = hex.EncodeToString(sum[:])[:12]
		}
		return filepath.Join(dir, "ws-"+key+".sock")
	default:
		return filepath.Join(dir, "global.sock")
	}
}

// listenMCPBridge creates the 0600 unix socket. A live daemon already on the
// path is an error; a stale socket file is removed.
func listenMCPBridge(socketPath string) (net.Listener, func(), error) {
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o700); err != nil {
		return nil, nil, err
	}
	if conn, err := net.DialTimeout("unix", socketPath, 200*time.Millisecond); err == nil {
		_ = conn.Close()
		return nil, nil, errors.New("MCP 共享桥已在运行")
	}
	_ = os.Remove(socketPath)
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return nil, nil, err
	}
	if err := os.Chmod(socketPath, 0o600); err != nil {
		_ = listener.Close()
		_ = os.Remove(socketPath)
		return nil, nil, err
	}
	return listener, func() {
		_ = listener.Close()
		_ = os.Remove(socketPath)
	}, nil
}

func dialMCPBridge(socketPath string, timeout time.Duration) (net.Conn, error) {
	return net.DialTimeout("unix", socketPath, timeout)
}

func mcpBridgeSupported() bool { return true }

// startMCPBridgeDaemon launches a detached daemon for the given socket.
func startMCPBridgeDaemon(aiHomeDir, socketPath string) error {
	self, err := os.Executable()
	if err != nil || self == "" {
		return errors.New("aih-server executable unavailable")
	}
	// 只有 server 本体能承载 daemon；测试二进制/自定义宿主直接回退到每会话桥。
	if !strings.Contains(strings.ToLower(filepath.Base(self)), "aih-server") {
		return errors.New("current executable is not aih-server")
	}
	logDir := filepath.Join(aiHomeDir, "run", "mcp-bridge")
	if err := os.MkdirAll(logDir, 0o700); err != nil {
		return err
	}
	logFile, err := os.OpenFile(filepath.Join(logDir, "daemon.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	command := exec.Command(self, "__mcp-bridge-daemon", "--socket", socketPath)
	command.Stdout = logFile
	command.Stderr = logFile
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := command.Start(); err != nil {
		_ = logFile.Close()
		return err
	}
	go func() {
		_ = command.Wait()
		_ = logFile.Close()
	}()
	return nil
}
