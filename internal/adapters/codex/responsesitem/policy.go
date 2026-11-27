// Package responsesitem 定义 Codex Responses 输入项里“上游无法重放”的辅助类型。
//
// 这些项只是 Codex 客户端的本地轨迹（工具发现、本地 shell、web 搜索），真正的
// 工具定义会随 tools 重新声明。原样回放会让上游 400 invalid_request 或
// unsupported_persisted_item_context；HTTP 原生清洗与 WebSocket 续接展开必须
// 使用同一份名单，避免两条入口各自维护而漂移。
package responsesitem

import "strings"

// UnreplayableInputItemTypes 是上游 Responses 不认识的 Codex 客户端辅助项。
var UnreplayableInputItemTypes = map[string]bool{
	"tool_search_call":        true,
	"tool_search_output":      true,
	"local_shell_call":        true,
	"local_shell_call_output": true,
	"web_search_call":         true,
}

// IsUnreplayableInputItem 报告该 item.type 是否必须从输入历史中移除。
func IsUnreplayableInputItem(itemType string) bool {
	return UnreplayableInputItemTypes[strings.TrimSpace(itemType)]
}
