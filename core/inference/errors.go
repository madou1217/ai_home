// Package inference 定义与 Provider 和传输协议解耦的推理领域合同。
//
// Client Decoder、Provider Encoder、Provider Decoder 和 Client Renderer
// 只能通过本包的不可变值对象交换数据，不能传播 Provider JSON 或凭据。
package inference

import "errors"

var (
	// ErrInvalidProviderID 表示账号归属不是当前阶段支持的规范 Provider。
	ErrInvalidProviderID = errors.New("推理 Provider ID 无效")
	// ErrInvalidProtocolID 表示上游线协议未注册或值不规范。
	ErrInvalidProtocolID = errors.New("上游协议 ID 无效")
	// ErrInvalidClientProtocolID 表示客户端入口协议未注册或值不规范。
	ErrInvalidClientProtocolID = errors.New("客户端协议 ID 无效")
	// ErrInvalidContent 表示内容块的类型、来源或内容不满足不变量。
	ErrInvalidContent = errors.New("推理内容无效")
	// ErrInvalidMessage 表示消息角色、内容或组合不满足协议公共约束。
	ErrInvalidMessage = errors.New("推理消息无效")
	// ErrInvalidJSONObject 表示需要 JSON Object 的位置收到空值、数组或非法 JSON。
	ErrInvalidJSONObject = errors.New("JSON Object 无效")
	// ErrInvalidToolName 表示工具名无法被 Codex 和 Claude 安全传输。
	ErrInvalidToolName = errors.New("工具名称无效")
	// ErrInvalidToolCallID 表示工具调用缺少可精确配对的稳定标识。
	ErrInvalidToolCallID = errors.New("工具调用 ID 无效")
	// ErrInvalidToolResult 表示工具结果为空或包含不允许的递归内容。
	ErrInvalidToolResult = errors.New("工具结果无效")
	// ErrInvalidReasoning 表示 reasoning 配置或连续性数据不完整。
	ErrInvalidReasoning = errors.New("reasoning 数据无效")
	// ErrInvalidUsage 表示 token 明细互相矛盾或总量溢出。
	ErrInvalidUsage = errors.New("token usage 无效")
	// ErrInvalidRequest 表示 Canonical Request 的基础字段无效。
	ErrInvalidRequest = errors.New("Canonical Request 无效")
	// ErrUnmatchedToolResult 表示工具结果无法通过明确 call ID 找到历史调用。
	ErrUnmatchedToolResult = errors.New("工具结果没有精确匹配的调用")
	// ErrMissingToolResult 表示请求历史以尚未返回结果的工具调用结束。
	ErrMissingToolResult = errors.New("工具调用缺少结果")
	// ErrInvalidEvent 表示 Canonical 流事件缺少其类型要求的字段。
	ErrInvalidEvent = errors.New("Canonical 流事件无效")
)
