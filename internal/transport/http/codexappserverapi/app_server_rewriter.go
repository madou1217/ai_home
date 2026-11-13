// Package codexappserverapi 提供 Codex app-server WebSocket 代理、remote-control
// HTTP/WS 代理以及 JSON-RPC 会话消息重写与 thread/resume 响应补丁的 HTTP 边界实现。
package codexappserverapi

import (
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/codexappserverws"
)

const (
	// AppServerProxyPath 是 Codex app-server WebSocket 升级入口路径。
	AppServerProxyPath = "/v0/codex/app-server"
	// CodexFlagsEnv 是合并传递 Codex 启动开关的环境变量名。
	CodexFlagsEnv = codexappserverws.CodexFlagsEnv
)

// ParseCodexFlags 解析 AIH_CODEX_FLAGS 逗号分隔键值对。
func ParseCodexFlags(raw string) map[string]string {
	return codexappserverws.ParseCodexFlags(raw)
}

// SetCodexFlag 更新并按契约顺序重新序列化 AIH_CODEX_FLAGS 环境变量值。
func SetCodexFlag(current string, key string, value string) string {
	return codexappserverws.SetCodexFlag(current, key, value)
}

// IsAppServerUpgradePath 判断请求路径是否匹配 Codex app-server 升级入口（/ 或 /v0/codex/app-server）。
func IsAppServerUpgradePath(path string) bool {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		trimmed = "/"
	}
	return trimmed == "/" || trimmed == AppServerProxyPath
}

// IsUpgradeRequest 判断请求是否携带 WebSocket Upgrade 请求头。
func IsUpgradeRequest(request *http.Request) bool {
	if request == nil {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(request.Header.Get("Upgrade")), "websocket") &&
		headerContainsToken(request.Header.Values("Connection"), "upgrade")
}

func headerContainsToken(values []string, token string) bool {
	for _, raw := range values {
		for _, part := range strings.Split(raw, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}

// RewriteClientMessage 对客户端发往 Codex app-server 的 JSON-RPC 请求执行兼容性重写。
func RewriteClientMessage(raw []byte, injectedCwd string) []byte {
	return codexappserverws.RewriteClientMessage(raw, codexappserverws.RewriteOptions{
		Cwd: injectedCwd,
	})
}

// ResponseContext 保存需要修补响应的 JSON-RPC 请求上下文。
type ResponseContext struct {
	Method   string
	ThreadID string
}

// ResponseContextTracker 线程安全地记录进行中的 thread/resume 请求并修补响应缺失的 threadIds 字段。
type ResponseContextTracker struct {
	tracker *codexappserverws.ResumeTracker
}

// NewResponseContextTracker 创建 JSON-RPC 响应上下文跟踪器。
func NewResponseContextTracker() *ResponseContextTracker {
	return &ResponseContextTracker{
		tracker: codexappserverws.NewResumeTracker(),
	}
}

// RememberThreadResumeRequest 若报文为带 id 的 thread/resume 请求，则记录其目标 threadId。
func (t *ResponseContextTracker) RememberThreadResumeRequest(raw []byte) bool {
	if t == nil || t.tracker == nil {
		return false
	}
	return t.tracker.RememberRequest(raw)
}

// PatchThreadResumeResponse 为缺少 result.threadIds 的 thread/resume 响应补齐 [threadId]。
func (t *ResponseContextTracker) PatchThreadResumeResponse(raw []byte) []byte {
	if t == nil || t.tracker == nil {
		return raw
	}
	return t.tracker.PatchResponse(raw)
}

// 以下两个包内辅助函数供同包 remote_control_proxy.go 生成脱敏 trace 摘要使用。
func extractJSONRPCIDString(payload map[string]any) string {
	return codexappserverws.ExtractJSONRPCIDFromMap(payload)
}

func extractJSONRPCThreadID(payload map[string]any) string {
	return codexappserverws.ExtractJSONRPCThreadIDFromMap(payload)
}
