//go:build windows

package webuisshapi

import (
	"errors"
	"net"
	"time"
)

// Windows 的命名管道权限模型尚未验证；共享模式回退到每会话一个桥。
func mcpBridgeSocketPath(string, string, string) string { return "" }

func listenMCPBridge(string) (net.Listener, func(), error) {
	return nil, nil, errors.New("MCP 共享桥暂不支持 Windows")
}

func dialMCPBridge(string, time.Duration) (net.Conn, error) {
	return nil, errors.New("MCP 共享桥暂不支持 Windows")
}

func mcpBridgeSupported() bool { return false }

func startMCPBridgeDaemon(string, string) error {
	return errors.New("MCP 共享桥暂不支持 Windows")
}
