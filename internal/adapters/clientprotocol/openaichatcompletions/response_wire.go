package openaichatcompletions

import (
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
)

// RenderedEvent 复用客户端协议层的不可变 SSE 事件值对象。
type RenderedEvent = clientprotocol.RenderedEvent

// chatCompletionWire 是非流式 Chat Completion 响应。
type chatCompletionWire struct {
	// ID 是 Provider 响应 ID。
	ID string `json:"id"`
	// Object 固定为 chat.completion。
	Object string `json:"object"`
	// Created 是注入时钟生成的 Unix 秒。
	Created int64 `json:"created"`
	// Model 是上游确认使用的真实模型。
	Model string `json:"model"`
	// Choices 当前只包含 index 0。
	Choices []chatCompletionChoice `json:"choices"`
	// Usage 是最终累计 token 快照。
	Usage chatUsageWire `json:"usage"`
}

// chatCompletionChoice 是当前单 choice 输出。
type chatCompletionChoice struct {
	// Index 固定为零。
	Index uint32 `json:"index"`
	// Message 是完整 Assistant 输出。
	Message chatMessageWire `json:"message"`
	// FinishReason 是 Chat 公开完成原因。
	FinishReason string `json:"finish_reason"`
}

// chatMessageWire 是 Chat Assistant 的完整输出消息。
type chatMessageWire struct {
	// Role 固定为 assistant。
	Role string `json:"role"`
	// Content 在没有可见文本时显式为 null。
	Content *string `json:"content"`
	// ReasoningContent 是可见 reasoning 摘要或 thinking 文本。
	ReasoningContent string `json:"reasoning_content,omitempty"`
	// Refusal 是策略拒绝内容。
	Refusal string `json:"refusal,omitempty"`
	// ToolCalls 是按生成顺序排列的函数调用。
	ToolCalls []chatToolCallWire `json:"tool_calls,omitempty"`
}

// chatToolCallWire 是完整函数调用。
type chatToolCallWire struct {
	// ID 是工具结果必须引用的调用标识。
	ID string `json:"id"`
	// Type 固定为 function。
	Type string `json:"type"`
	// Function 保存名称和完整参数。
	Function chatFunctionCallWire `json:"function"`
}

// chatFunctionCallWire 保存函数名和完整 JSON 参数字符串。
type chatFunctionCallWire struct {
	// Name 是函数工具名。
	Name string `json:"name"`
	// Arguments 是完整 JSON Object 字符串。
	Arguments string `json:"arguments"`
}

// chatUsageWire 是 Chat token 使用量及可表达的子集。
type chatUsageWire struct {
	// PromptTokens 是累计输入 token。
	PromptTokens uint64 `json:"prompt_tokens"`
	// CompletionTokens 是累计输出 token。
	CompletionTokens uint64 `json:"completion_tokens"`
	// TotalTokens 是安全预计算的总 token。
	TotalTokens uint64 `json:"total_tokens"`
	// PromptTokensDetails 是输入缓存子集。
	PromptTokensDetails chatPromptTokenDetailsWire `json:"prompt_tokens_details"`
	// CompletionTokensDetails 是输出 reasoning 子集。
	CompletionTokensDetails chatCompletionTokenDetailsWire `json:"completion_tokens_details"`
}

// chatPromptTokenDetailsWire 保存缓存读取和写入 token。
type chatPromptTokenDetailsWire struct {
	// CachedTokens 是缓存命中的输入 token。
	CachedTokens uint64 `json:"cached_tokens"`
	// CacheWriteTokens 是写入缓存的输入 token 扩展。
	CacheWriteTokens uint64 `json:"cache_write_tokens,omitempty"`
}

// chatCompletionTokenDetailsWire 保存 reasoning token。
type chatCompletionTokenDetailsWire struct {
	// ReasoningTokens 是 reasoning 使用的输出 token。
	ReasoningTokens uint64 `json:"reasoning_tokens"`
}

// chatChunkWire 是 data-only SSE 中的 Chat Completion Chunk。
type chatChunkWire struct {
	// ID 在整个响应流中保持不变。
	ID string `json:"id"`
	// Object 固定为 chat.completion.chunk。
	Object string `json:"object"`
	// Created 在整个响应流中保持不变。
	Created int64 `json:"created"`
	// Model 是上游确认使用的真实模型。
	Model string `json:"model"`
	// Choices 是单 choice 增量；usage 尾块明确为空数组。
	Choices []chatChunkChoice `json:"choices"`
	// Usage 只在客户端明确请求的尾块中出现。
	Usage *chatUsageWire `json:"usage,omitempty"`
}

// chatChunkChoice 是单 choice 的增量或完成原因。
type chatChunkChoice struct {
	// Index 固定为零。
	Index uint32 `json:"index"`
	// Delta 是本帧新增的 Assistant 字段。
	Delta chatDeltaWire `json:"delta"`
	// FinishReason 在非终止 choice 帧中为 null。
	FinishReason *string `json:"finish_reason"`
}

// chatDeltaWire 是 Chat 可增量表达的 Assistant 字段。
type chatDeltaWire struct {
	// Role 只在首帧输出 assistant。
	Role string `json:"role,omitempty"`
	// Content 是普通文本增量。
	Content string `json:"content,omitempty"`
	// ReasoningContent 是可见 reasoning 增量。
	ReasoningContent string `json:"reasoning_content,omitempty"`
	// Refusal 是策略拒绝增量。
	Refusal string `json:"refusal,omitempty"`
	// ToolCalls 是一个或多个函数调用增量。
	ToolCalls []chatToolCallDeltaWire `json:"tool_calls,omitempty"`
}

// chatToolCallDeltaWire 是按工具序号定位的函数调用增量。
type chatToolCallDeltaWire struct {
	// Index 是 choice 内连续工具序号。
	Index uint32 `json:"index"`
	// ID 只在工具首帧出现。
	ID string `json:"id,omitempty"`
	// Type 只在工具首帧出现并固定为 function。
	Type string `json:"type,omitempty"`
	// Function 保存可选名称和参数增量。
	Function chatFunctionCallDeltaWire `json:"function"`
}

// chatFunctionCallDeltaWire 使用指针区分省略字段和明确空参数。
type chatFunctionCallDeltaWire struct {
	// Name 只在工具首帧出现。
	Name *string `json:"name,omitempty"`
	// Arguments 可以是明确空字符串或非空参数增量。
	Arguments *string `json:"arguments,omitempty"`
}

// chatErrorEnvelopeWire 是流已经提交后可发送的低敏错误帧。
type chatErrorEnvelopeWire struct {
	// Error 是已经脱敏的流式失败。
	Error chatErrorWire `json:"error"`
}

// chatErrorWire 只携带 Canonical 失败分类和安全说明。
type chatErrorWire struct {
	// Type 是稳定的 Chat 错误类别。
	Type string `json:"type"`
	// Code 是 Canonical 失败分类代码。
	Code string `json:"code"`
	// Message 是上游 Adapter 提供的安全说明。
	Message string `json:"message"`
}

// newChatUsageWire 把 Canonical 累计 usage 映射为 Chat 结构。
func newChatUsageWire(usage inference.Usage) chatUsageWire {
	return chatUsageWire{
		PromptTokens:     usage.InputTokens(),
		CompletionTokens: usage.OutputTokens(),
		TotalTokens:      usage.TotalTokens(),
		PromptTokensDetails: chatPromptTokenDetailsWire{
			CachedTokens:     usage.CachedInputTokens(),
			CacheWriteTokens: usage.CacheWriteInputTokens(),
		},
		CompletionTokensDetails: chatCompletionTokenDetailsWire{
			ReasoningTokens: usage.ReasoningTokens(),
		},
	}
}

// stringPointer 返回必须显式序列化的字符串指针。
func stringPointer(value string) *string {
	return &value
}
