// Package approvaltool 实现 Claude 权限提示 MCP server（stdio JSON-RPC）。
//
// 背景：Claude CLI 用 --permission-prompt-tool 调用一个 MCP server 来征求用户许可。
// 该进程由 Claude 而不是 aih 启动，原先是一份 Node 脚本（lib/server/claude-permission-mcp-tool.js）。
// 本包把同一协议搬进 Go 宿主二进制：子命令 __mcp-approve 由 aih-server 自己提供，
// 审批链（启动 → 长挂等待 → 决策）不再需要 Node 运行时。
//
// 协议与 Node 版本逐字一致：
//   - stdin/stdout 上的换行分隔 JSON-RPC；
//   - initialize / tools/list / tools/call 三个方法；
//   - tools/call 把 {runId,toolName,input,toolUseId} POST 给 launch context 里的审批桥，
//     长挂等待用户决策；桥不可达或超时一律 deny（安全默认，Claude 会优雅收尾）。
package approvaltool

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	// LaunchContextEnv 是 aih 注入的 0600 JSON 文件路径（与 Node 版本同名）。
	LaunchContextEnv = "AIH_LAUNCH_CONTEXT"
	// decisionTimeout 与 Node 版本的 600s 长挂一致。
	decisionTimeout = 10 * time.Minute
	maxMessageBytes = 8 * 1024 * 1024
)

type launchContext struct {
	ApprovalURL string `json:"approvalUrl"`
	RunID       string `json:"runId"`
}

// Run 读取 launch context 并在 stdin/stdout 上服务 MCP 协议，直到 stdin 关闭。
func Run(stdin io.Reader, stdout io.Writer, getenv func(string) string) error {
	context := readLaunchContext(getenv)
	scanner := bufio.NewScanner(stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), maxMessageBytes)
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
		reply := handleMessage(message, context)
		if reply == nil {
			continue
		}
		if err := encoder.Encode(reply); err != nil {
			return err
		}
	}
	return scanner.Err()
}

// readLaunchContext 读取并解析 AIH_LAUNCH_CONTEXT；任何失败都返回空上下文，
// 后续 tools/call 会以 deny 安全收尾。
func readLaunchContext(getenv func(string) string) launchContext {
	if getenv == nil {
		return launchContext{}
	}
	path := strings.TrimSpace(getenv(LaunchContextEnv))
	if path == "" {
		return launchContext{}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return launchContext{}
	}
	var parsed launchContext
	if json.Unmarshal(raw, &parsed) != nil {
		return launchContext{}
	}
	parsed.ApprovalURL = strings.TrimSpace(parsed.ApprovalURL)
	parsed.RunID = strings.TrimSpace(parsed.RunID)
	return parsed
}

// handleMessage 处理单条 JSON-RPC 消息；通知（没有 id）返回 nil。
func handleMessage(message map[string]any, context launchContext) map[string]any {
	method, _ := message["method"].(string)
	id, hasID := message["id"]
	params, _ := message["params"].(map[string]any)
	switch method {
	case "initialize":
		version := "2024-11-05"
		if candidate, ok := params["protocolVersion"].(string); ok && strings.TrimSpace(candidate) != "" {
			version = candidate
		}
		return replyResult(id, map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "aih-approve", "version": "1.0.0"},
		})
	case "tools/list":
		return replyResult(id, map[string]any{
			"tools": []any{map[string]any{
				"name":        "approve",
				"description": "AIH webUI permission prompt tool",
				"inputSchema": map[string]any{
					"type":                 "object",
					"properties":           map[string]any{"tool_name": map[string]any{"type": "string"}, "input": map[string]any{"type": "object"}},
					"additionalProperties": true,
				},
			}},
		})
	case "tools/call":
		arguments, _ := params["arguments"].(map[string]any)
		decision := requestDecision(context, arguments)
		result := map[string]any{"behavior": "deny", "message": "用户在 webUI 拒绝了此操作"}
		if behavior, _ := decision["behavior"].(string); behavior == "allow" {
			updated := arguments["input"]
			if candidate, ok := decision["updatedInput"]; ok {
				updated = candidate
			}
			if updated == nil {
				updated = map[string]any{}
			}
			result = map[string]any{"behavior": "allow", "updatedInput": updated}
		} else if message, _ := decision["message"].(string); strings.TrimSpace(message) != "" {
			result = map[string]any{"behavior": "deny", "message": message}
		}
		encoded, err := json.Marshal(result)
		if err != nil {
			encoded = []byte("{\"behavior\":\"deny\",\"message\":\"审批结果序列化失败\"}")
		}
		return replyResult(id, map[string]any{
			"content": []any{map[string]any{"type": "text", "text": string(encoded)}},
		})
	}
	if !hasID {
		return nil
	}
	return replyResult(id, map[string]any{})
}

func replyResult(id any, result map[string]any) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": id, "result": result}
}

// requestDecision 把审批请求 POST 给桥并长挂等待；任何失败都返回 deny。
func requestDecision(context launchContext, arguments map[string]any) map[string]any {
	if context.ApprovalURL == "" {
		return map[string]any{"behavior": "deny", "message": "aih 审批桥未配置(launch context 缺 approvalUrl)"}
	}
	toolName, _ := arguments["tool_name"].(string)
	toolUseID, _ := arguments["tool_use_id"].(string)
	input, _ := arguments["input"].(map[string]any)
	if input == nil {
		input = map[string]any{}
	}
	body, err := json.Marshal(map[string]any{
		"runId":     context.RunID,
		"toolName":  strings.TrimSpace(toolName),
		"input":     input,
		"toolUseId": strings.TrimSpace(toolUseID),
	})
	if err != nil {
		return map[string]any{"behavior": "deny", "message": "审批请求序列化失败"}
	}
	request, err := http.NewRequest(http.MethodPost, context.ApprovalURL, bytes.NewReader(body))
	if err != nil {
		return map[string]any{"behavior": "deny", "message": "aih 审批桥地址无效"}
	}
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: decisionTimeout}
	response, err := client.Do(request)
	if err != nil {
		return map[string]any{"behavior": "deny", "message": fmt.Sprintf("aih 审批桥不可达: %v", err)}
	}
	defer func() { _ = response.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return map[string]any{"behavior": "deny", "message": "aih 审批桥返回不可读"}
	}
	var decision map[string]any
	if json.Unmarshal(raw, &decision) != nil {
		return map[string]any{"behavior": "deny", "message": "aih 审批桥返回无效决策"}
	}
	behavior, _ := decision["behavior"].(string)
	if behavior != "allow" && behavior != "deny" {
		return map[string]any{"behavior": "deny", "message": "aih 审批桥返回无效决策"}
	}
	return decision
}
