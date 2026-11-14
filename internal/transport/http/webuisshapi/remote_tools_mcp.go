package webuisshapi

// 远程工作区工具 MCP server（stdio）。
//
// 由 Claude / Codex 在宿主本机拉起：command 是宿主二进制自身，args 是
// __mcp-remote-tools。launch context（0600 JSON）有两种形态：
//   - {aiHomeDir, workspaceId}：直连模式，本进程自己建 SSH 连接执行工具；
//   - {toolsUrl, token}：转发模式，把调用 POST 给 aih 的内部工具端点。
//
// 与 Node 版 remote-tools-mcp-server.js 的协议一致：initialize / ping /
// tools/list / tools/call；工具错误以 content + isError 返回，不让 harness 挂死。

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const remoteToolsLaunchContextEnv = "AIH_LAUNCH_CONTEXT"

type remoteToolsLaunchContext struct {
	AIHomeDir   string `json:"aiHomeDir"`
	WorkspaceID string `json:"workspaceId"`
	ToolsURL    string `json:"toolsUrl"`
	Token       string `json:"token"`
}

// RunRemoteToolsMCP 在 stdin/stdout 上服务 MCP 协议，直到 stdin 关闭。
func RunRemoteToolsMCP(stdin io.Reader, stdout io.Writer, getenv func(string) string) error {
	launch := readRemoteToolsLaunchContext(getenv)
	scanner := bufio.NewScanner(stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	encoder := json.NewEncoder(stdout)
	encoder.SetEscapeHTML(false)
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
		if err := encoder.Encode(reply); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func readRemoteToolsLaunchContext(getenv func(string) string) remoteToolsLaunchContext {
	if getenv == nil {
		return remoteToolsLaunchContext{}
	}
	path := strings.TrimSpace(getenv(remoteToolsLaunchContextEnv))
	if path == "" {
		return remoteToolsLaunchContext{}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return remoteToolsLaunchContext{}
	}
	var parsed remoteToolsLaunchContext
	if json.Unmarshal(raw, &parsed) != nil {
		return remoteToolsLaunchContext{}
	}
	parsed.AIHomeDir = strings.TrimSpace(parsed.AIHomeDir)
	parsed.WorkspaceID = strings.TrimSpace(parsed.WorkspaceID)
	parsed.ToolsURL = strings.TrimSpace(parsed.ToolsURL)
	parsed.Token = strings.TrimSpace(parsed.Token)
	return parsed
}

func handleRemoteToolsMessage(message map[string]any, launch remoteToolsLaunchContext) map[string]any {
	method, _ := message["method"].(string)
	id, hasID := message["id"]
	params, _ := message["params"].(map[string]any)
	switch method {
	case "initialize":
		version := "2025-06-18"
		if candidate, ok := params["protocolVersion"].(string); ok && strings.TrimSpace(candidate) != "" {
			version = candidate
		}
		return remoteToolsReply(id, map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "aih-remote-workspace", "version": "1.0.0"},
		})
	case "notifications/initialized":
		return nil
	case "ping":
		return remoteToolsReply(id, map[string]any{})
	case "tools/list":
		return remoteToolsReply(id, map[string]any{"tools": RemoteToolDefinitions()})
	case "tools/call":
		name, _ := params["name"].(string)
		arguments, _ := params["arguments"].(map[string]any)
		result := callRemoteToolForLaunch(launch, name, arguments)
		return remoteToolsReply(id, result)
	}
	if !hasID {
		return nil
	}
	return map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": -32601, "message": "method not found: " + method}}
}

func remoteToolsReply(id any, result map[string]any) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": id, "result": result}
}

func callRemoteToolForLaunch(launch remoteToolsLaunchContext, name string, arguments map[string]any) map[string]any {
	if launch.ToolsURL != "" {
		return postRemoteToolCall(launch, name, arguments)
	}
	if launch.AIHomeDir == "" || launch.WorkspaceID == "" {
		return remoteToolError("remote_tools_unconfigured", "远程工具上下文未配置")
	}
	hostHomeDir := strings.TrimSpace(os.Getenv("HOME"))
	return CallRemoteTool(context.Background(), RemoteToolOptions{
		AIHomeDir:   launch.AIHomeDir,
		HostHomeDir: hostHomeDir,
		WorkspaceID: launch.WorkspaceID,
	}, name, arguments)
}

func postRemoteToolCall(launch remoteToolsLaunchContext, name string, arguments map[string]any) map[string]any {
	body, err := json.Marshal(map[string]any{"name": name, "arguments": arguments})
	if err != nil {
		return remoteToolError("remote_tools_bad_request", "工具调用序列化失败")
	}
	request, err := http.NewRequest(http.MethodPost, launch.ToolsURL, bytes.NewReader(body))
	if err != nil {
		return remoteToolError("remote_tools_unconfigured", "远程工具端点地址无效")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-AIH-Remote-Tools-Token", launch.Token)
	client := &http.Client{Timeout: 35 * time.Minute}
	response, err := client.Do(request)
	if err != nil {
		return remoteToolError("remote_tools_unreachable", err.Error())
	}
	defer func() { _ = response.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 8*1024*1024))
	if err != nil {
		return remoteToolError("remote_tools_bad_response", "读取远端工具响应失败")
	}
	var parsed map[string]any
	if json.Unmarshal(raw, &parsed) != nil || parsed["content"] == nil {
		return remoteToolError("remote_tools_bad_response", fmt.Sprintf("HTTP %d", response.StatusCode))
	}
	return parsed
}
