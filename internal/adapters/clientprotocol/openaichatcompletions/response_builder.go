package openaichatcompletions

import (
	"strings"

	"github.com/madou1217/ai_home/core/inference"
)

// buildCompletionWire 聚合全部输出项为单 choice Chat Completion。
func (state *responseState) buildCompletionWire() (chatCompletionWire, error) {
	if !state.completed {
		return chatCompletionWire{}, ErrResponseNotCompleted
	}
	finishReason, err := mapFinishReason(state.stopReason)
	if err != nil {
		return chatCompletionWire{}, err
	}
	message := state.buildMessageWire()
	return chatCompletionWire{
		ID:      state.responseID,
		Object:  "chat.completion",
		Created: state.createdAt,
		Model:   state.model,
		Choices: []chatCompletionChoice{{
			Index:        0,
			Message:      message,
			FinishReason: finishReason,
		}},
		Usage: newChatUsageWire(state.usage),
	}, nil
}

// buildMessageWire 按内容类别聚合为 Chat Assistant 消息字段。
func (state *responseState) buildMessageWire() chatMessageWire {
	var text strings.Builder
	var reasoning strings.Builder
	var refusal strings.Builder
	for _, item := range state.items {
		for _, block := range item.blocks {
			switch block.kind {
			case inference.ContentText:
				text.WriteString(block.text)
			case inference.ContentReasoning:
				reasoning.WriteString(block.text)
			case inference.ContentRefusal:
				refusal.WriteString(block.text)
			}
		}
	}
	message := chatMessageWire{
		Role:             "assistant",
		ReasoningContent: reasoning.String(),
		Refusal:          refusal.String(),
		ToolCalls:        state.buildToolCallsWire(),
	}
	if text.Len() > 0 {
		content := text.String()
		message.Content = &content
	}
	return message
}

// buildToolCallsWire 按分配的连续序号生成完整函数调用。
func (state *responseState) buildToolCallsWire() []chatToolCallWire {
	if len(state.toolCalls) == 0 {
		return nil
	}
	toolCalls := make([]chatToolCallWire, len(state.toolCalls))
	for index, toolCall := range state.toolCalls {
		toolCalls[index] = chatToolCallWire{
			ID:   toolCall.callID,
			Type: "function",
			Function: chatFunctionCallWire{
				Name:      toolCall.name,
				Arguments: toolCall.arguments,
			},
		}
	}
	return toolCalls
}

// mapFinishReason 把 Canonical 完成原因映射为 Chat 公开枚举。
func mapFinishReason(reason inference.StopReason) (string, error) {
	switch reason {
	case inference.StopReasonEndTurn, inference.StopReasonStopSequence:
		return "stop", nil
	case inference.StopReasonMaxTokens:
		return "length", nil
	case inference.StopReasonToolUse:
		return "tool_calls", nil
	case inference.StopReasonContentFilter:
		return "content_filter", nil
	default:
		return "", ErrUnsupportedResponseEvent
	}
}
