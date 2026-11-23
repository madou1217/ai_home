// aih-mcp-shim 是共享 MCP 桥的薄客户端。
//
// 它只做三件事：读取 launch context、把上下文注册给 daemon、双向转发 stdio。
// 刻意不导入服务器依赖：进程 RSS 保持在个位数 MB，共享桥的内存收益才成立。
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"time"
)

const launchContextEnv = "AIH_LAUNCH_CONTEXT"

type launchContext struct {
	BridgeSocket string `json:"bridgeSocket"`
	SessionToken string `json:"sessionToken"`
}

func main() {
	raw, err := os.ReadFile(os.Getenv(launchContextEnv))
	if err != nil {
		fail("读取 launch context 失败: %v", err)
	}
	var context launchContext
	if err := json.Unmarshal(raw, &context); err != nil || context.BridgeSocket == "" {
		fail("launch context 没有 bridgeSocket")
	}
	conn, err := net.DialTimeout("unix", context.BridgeSocket, 2*time.Second)
	if err != nil {
		fail("连接 MCP 共享桥失败: %v", err)
	}
	registration, err := json.Marshal(map[string]any{
		"type":   "register",
		"token":  context.SessionToken,
		"launch": json.RawMessage(raw),
	})
	if err != nil {
		fail("注册消息序列化失败: %v", err)
	}
	if _, err := conn.Write(append(registration, '\n')); err != nil {
		fail("注册到 MCP 共享桥失败: %v", err)
	}
	go func() {
		_, _ = io.Copy(os.Stdout, conn)
		os.Exit(0)
	}()
	_, _ = io.Copy(conn, os.Stdin)
	_ = conn.Close()
}

func fail(format string, args ...any) {
	_, _ = fmt.Fprintf(os.Stderr, "aih-mcp-shim: "+format+"\n", args...)
	os.Exit(1)
}
