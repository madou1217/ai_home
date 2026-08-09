package anthropicmessages

import (
	"encoding/json"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
)

// RenderedEvent 复用客户端协议层的不可变 SSE 事件值对象。
type RenderedEvent = clientprotocol.RenderedEvent

// messageWireDTO 是非流式响应和 message_start 共用的 Messages 对象。
type messageWireDTO struct {
	ID           string              `json:"id"`
	Type         string              `json:"type"`
	Role         string              `json:"role"`
	Model        string              `json:"model"`
	Content      []json.RawMessage   `json:"content"`
	StopReason   *string             `json:"stop_reason"`
	StopSequence *string             `json:"stop_sequence"`
	StopDetails  *stopDetailsWireDTO `json:"stop_details,omitempty"`
	Usage        messageUsageWireDTO `json:"usage"`
	Container    *containerWireDTO   `json:"container,omitempty"`
}

// stopDetailsWireDTO 回传内容被拒绝的类别。
//
// 客户端据此选择回退模型：只知道「被拒了」而不知道原因时，本可换模型继续的
// 任务只能直接失败。
type stopDetailsWireDTO struct {
	Type     string `json:"type"`
	Category string `json:"category"`
}

// containerWireDTO 只作为 null 类型边界，当前 Canonical 响应没有容器状态。
type containerWireDTO struct {
	ID        string `json:"id"`
	ExpiresAt string `json:"expires_at"`
}

// messageUsageWireDTO 是完整 Message 的 token 使用量。
type messageUsageWireDTO struct {
	InputTokens              uint64                `json:"input_tokens"`
	CacheCreationInputTokens uint64                `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     uint64                `json:"cache_read_input_tokens"`
	OutputTokens             uint64                `json:"output_tokens"`
	CacheCreation            *cacheCreationWireDTO `json:"cache_creation"`
	ServerToolUse            *serverToolUseWireDTO `json:"server_tool_use,omitempty"`
	InferenceGeo             *string               `json:"inference_geo"`
}

// messageDeltaUsageWireDTO 是 message_delta 的累计 token 快照。
type messageDeltaUsageWireDTO struct {
	InputTokens              uint64                `json:"input_tokens"`
	CacheCreationInputTokens uint64                `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     uint64                `json:"cache_read_input_tokens"`
	OutputTokens             uint64                `json:"output_tokens"`
	ServerToolUse            *serverToolUseWireDTO `json:"server_tool_use,omitempty"`
}

// cacheCreationWireDTO 为当前尚无 TTL 分项的可选字段保留类型。
type cacheCreationWireDTO struct {
	Ephemeral1HInputTokens uint64 `json:"ephemeral_1h_input_tokens"`
	Ephemeral5MInputTokens uint64 `json:"ephemeral_5m_input_tokens"`
}

// serverToolUseWireDTO 为当前不支持的 Anthropic server tools 保留零值类型。
type serverToolUseWireDTO struct {
	WebSearchRequests uint64 `json:"web_search_requests"`
	WebFetchRequests  uint64 `json:"web_fetch_requests"`
}

// textBlockWireDTO 是普通文本或 refusal 在 Messages 中的共同输出形状。
type textBlockWireDTO struct {
	Type      string            `json:"type"`
	Text      string            `json:"text"`
	Citations []json.RawMessage `json:"citations,omitempty"`
}

// thinkingBlockWireDTO 是 signed thinking 输出块。
type thinkingBlockWireDTO struct {
	Type      string `json:"type"`
	Thinking  string `json:"thinking"`
	Signature string `json:"signature"`
}

// redactedThinkingBlockWireDTO 是不可读 reasoning 连续性输出块。
type redactedThinkingBlockWireDTO struct {
	Type string `json:"type"`
	Data string `json:"data"`
}

// toolUseBlockWireDTO 是 Messages 客户端工具调用输出块。
type toolUseBlockWireDTO struct {
	Type  string          `json:"type"`
	ID    string          `json:"id"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
}

// streamEventWireDTO 是 Messages SSE 事件的类型化字段并集。
type streamEventWireDTO struct {
	Type         string                    `json:"type"`
	Message      *messageWireDTO           `json:"message,omitempty"`
	Index        *uint32                   `json:"index,omitempty"`
	ContentBlock json.RawMessage           `json:"content_block,omitempty"`
	Delta        json.RawMessage           `json:"delta,omitempty"`
	Usage        *messageDeltaUsageWireDTO `json:"usage,omitempty"`
	Error        *errorWireDTO             `json:"error,omitempty"`
}

// messageDeltaWireDTO 是完成事件携带的停止原因。
type messageDeltaWireDTO struct {
	StopReason   string            `json:"stop_reason"`
	StopSequence *string           `json:"stop_sequence"`
	Container    *containerWireDTO `json:"container"`
}

// textDeltaWireDTO 是普通文本增量。
type textDeltaWireDTO struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// thinkingDeltaWireDTO 是 thinking 文本增量。
type thinkingDeltaWireDTO struct {
	Type     string `json:"type"`
	Thinking string `json:"thinking"`
}

// signatureDeltaWireDTO 是 thinking 签名增量。
type signatureDeltaWireDTO struct {
	Type      string `json:"type"`
	Signature string `json:"signature"`
}

// inputJSONDeltaWireDTO 是工具参数 JSON 的原始增量。
type inputJSONDeltaWireDTO struct {
	Type        string `json:"type"`
	PartialJSON string `json:"partial_json"`
}

// errorWireDTO 是 Anthropic SSE error 事件的低敏错误。
type errorWireDTO struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

// errorResponseWireDTO 是非流式 Messages 错误响应。
type errorResponseWireDTO struct {
	Type  string       `json:"type"`
	Error errorWireDTO `json:"error"`
}

// buildStartMessageWire 创建 message_start 使用的空内容和零 usage。
func (state *responseState) buildStartMessageWire() messageWireDTO {
	return messageWireDTO{
		ID:        state.responseID,
		Type:      "message",
		Role:      "assistant",
		Model:     state.model,
		Content:   []json.RawMessage{},
		Usage:     newMessageUsageWire(inference.Usage{}),
		Container: nil,
	}
}

// buildCompletedMessageWire 创建非流式完整响应。
func (state *responseState) buildCompletedMessageWire() (messageWireDTO, error) {
	if !state.completed {
		return messageWireDTO{}, ErrResponseNotCompleted
	}
	content, err := state.marshalContent()
	if err != nil {
		return messageWireDTO{}, err
	}
	stopReason, err := mapStopReason(state.stopReason)
	if err != nil {
		return messageWireDTO{}, err
	}
	return messageWireDTO{
		ID:           state.responseID,
		Type:         "message",
		Role:         "assistant",
		Model:        state.model,
		Content:      content,
		StopReason:   &stopReason,
		StopSequence: optionalString(state.stopSequence),
		StopDetails:  newStopDetailsWire(state.refusalCategory),
		Usage:        newMessageUsageWire(state.usage),
		Container:    nil,
	}, nil
}

// newStopDetailsWire 仅在上游给出类别时生成 stop_details。
//
// 上游未给出类别是合法情况，此时省略该字段而不是发空对象。
func newStopDetailsWire(category string) *stopDetailsWireDTO {
	if category == "" {
		return nil
	}
	return &stopDetailsWireDTO{Type: "refusal", Category: category}
}

// marshalContent 按 Canonical output_index 和 block_index 展平 Messages 内容块。
func (state *responseState) marshalContent() ([]json.RawMessage, error) {
	content := make([]json.RawMessage, 0)
	for _, item := range state.items {
		switch item.kind {
		case inference.OutputItemMessage, inference.OutputItemReasoning:
			for _, block := range item.blocks {
				if shouldOmitReasoningBlock(block) {
					continue
				}
				encoded, err := marshalContentBlock(block)
				if err != nil {
					return nil, err
				}
				content = append(content, encoded)
			}
		case inference.OutputItemToolCall:
			encoded, err := json.Marshal(toolUseBlockWireDTO{
				Type:  "tool_use",
				ID:    item.callID,
				Name:  item.toolName,
				Input: json.RawMessage(item.toolArguments),
			})
			if err != nil {
				return nil, err
			}
			content = append(content, encoded)
		default:
			return nil, ErrUnsupportedResponseEvent
		}
	}
	return content, nil
}

// shouldOmitReasoningBlock 判断当前块是否只属于其他 Provider 的私有语义。
// 省略比伪造 Claude signature 或 redacted data 更安全，也不会破坏主结果。
func shouldOmitReasoningBlock(block *contentBlockState) bool {
	return block.kind == inference.ContentReasoning &&
		(block.reasoningKind == inference.ReasoningSummary ||
			block.reasoningKind == inference.ReasoningEncrypted)
}

// marshalContentBlock 编码文本、signed thinking 或 redacted thinking。
func marshalContentBlock(block *contentBlockState) (json.RawMessage, error) {
	switch block.kind {
	case inference.ContentText, inference.ContentRefusal:
		return json.Marshal(textBlockWireDTO{
			Type:      "text",
			Text:      block.text,
			Citations: nil,
		})
	case inference.ContentReasoning:
		switch block.reasoningKind {
		case inference.ReasoningThinking:
			return json.Marshal(thinkingBlockWireDTO{
				Type:      "thinking",
				Thinking:  block.text,
				Signature: block.signature,
			})
		case inference.ReasoningRedacted:
			return json.Marshal(redactedThinkingBlockWireDTO{
				Type: "redacted_thinking",
				Data: block.redactedData,
			})
		default:
			return nil, ErrUnsupportedResponseEvent
		}
	default:
		return nil, ErrUnsupportedResponseEvent
	}
}

// newMessageUsageWire 将 Canonical 总输入拆成 Anthropic 非缓存、写缓存和读缓存。
func newMessageUsageWire(usage inference.Usage) messageUsageWireDTO {
	return messageUsageWireDTO{
		InputTokens:              uncachedInputTokens(usage),
		CacheCreationInputTokens: usage.CacheWriteInputTokens(),
		CacheReadInputTokens:     usage.CachedInputTokens(),
		OutputTokens:             usage.OutputTokens(),
		CacheCreation:            nil,
		ServerToolUse:            nil,
		InferenceGeo:             nil,
	}
}

// newMessageDeltaUsageWire 创建 message_delta 的累计 usage。
func newMessageDeltaUsageWire(usage inference.Usage) messageDeltaUsageWireDTO {
	return messageDeltaUsageWireDTO{
		InputTokens:              uncachedInputTokens(usage),
		CacheCreationInputTokens: usage.CacheWriteInputTokens(),
		CacheReadInputTokens:     usage.CachedInputTokens(),
		OutputTokens:             usage.OutputTokens(),
		ServerToolUse:            nil,
	}
}

// uncachedInputTokens 返回 Anthropic usage.input_tokens 所需的非缓存部分。
func uncachedInputTokens(usage inference.Usage) uint64 {
	return usage.InputTokens() -
		usage.CachedInputTokens() -
		usage.CacheWriteInputTokens()
}

// mapStopReason 将 Canonical 结束原因无歧义映射到 Messages。
func mapStopReason(reason inference.StopReason) (string, error) {
	switch reason {
	case inference.StopReasonEndTurn:
		return "end_turn", nil
	case inference.StopReasonStopSequence:
		return "stop_sequence", nil
	case inference.StopReasonMaxTokens:
		return "max_tokens", nil
	case inference.StopReasonToolUse:
		return "tool_use", nil
	case inference.StopReasonPauseTurn:
		return "pause_turn", nil
	case inference.StopReasonContentFilter:
		return "refusal", nil
	default:
		return "", ErrUnsupportedResponseEvent
	}
}

// optionalString 将空字符串编码为 JSON null。
func optionalString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// ErrorTypeForFailure 把 Canonical 失败分类收敛到 Anthropic 公开错误类型。
// Canonical 运行态名称不会直接泄漏到客户端协议，也不会被误判为 overloaded。
func ErrorTypeForFailure(failure inference.ResponseFailure) string {
	errorType := failure.Code()
	switch errorType {
	case "invalid_request_error",
		"authentication_error",
		"permission_error",
		"not_found_error",
		"request_too_large",
		"rate_limit_error",
		"api_error",
		"overloaded_error":
	case string(runtimecore.FailureRateLimited),
		string(runtimecore.FailureQuotaExhausted):
		errorType = "rate_limit_error"
	case string(runtimecore.FailureModelOverloaded):
		errorType = "overloaded_error"
	default:
		if failure.Retryable() {
			errorType = "overloaded_error"
		} else {
			errorType = "api_error"
		}
	}
	return errorType
}

// newErrorWire 组合 Anthropic 错误类型和低敏说明。
func newErrorWire(failure inference.ResponseFailure) errorWireDTO {
	errorType := ErrorTypeForFailure(failure)
	message := failure.SafeMessage()
	if message == "" {
		message = "request failed"
	}
	return errorWireDTO{Type: errorType, Message: message}
}

// MarshalErrorResponse 把 Canonical 失败编码为低敏 Messages 错误响应。
func MarshalErrorResponse(failure inference.ResponseFailure) ([]byte, error) {
	if !failure.IsValid() {
		return nil, ErrUnsupportedResponseEvent
	}
	return json.Marshal(errorResponseWireDTO{
		Type:  "error",
		Error: newErrorWire(failure),
	})
}
