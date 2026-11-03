package openaichatcompletions

import (
	"bytes"
	"strings"

	"github.com/madou1217/ai_home/core/inference"
)

// startToolCall 为函数调用分配连续 Chat 工具序号。
func (state *responseState) startToolCall(
	event inference.ToolCallStartedEvent,
) error {
	item, err := state.openItem(event.OutputIndex())
	if err != nil ||
		item.kind != inference.OutputItemToolCall ||
		item.toolCall != nil ||
		event.BlockIndex() != 0 {
		return ErrInvalidEventSequence
	}
	if _, exists := state.callIDs[event.CallID()]; exists {
		return ErrInvalidEventSequence
	}
	toolCall := &chatToolCallState{
		index:  uint32(len(state.toolCalls)),
		callID: event.CallID(),
		name:   event.Name(),
	}
	state.callIDs[event.CallID()] = struct{}{}
	state.toolCalls = append(state.toolCalls, toolCall)
	item.toolCall = toolCall
	return nil
}

// appendToolArguments 追加属于明确 call ID 的参数增量。
func (state *responseState) appendToolArguments(
	event inference.ToolArgumentsDeltaEvent,
) error {
	toolCall, err := state.openToolCall(event.OutputIndex(), event.CallID())
	if err != nil || event.BlockIndex() != 0 {
		return ErrInvalidEventSequence
	}
	toolCall.arguments += event.Delta()
	return nil
}

// completeToolCall 校验累计参数前缀并保存完整 JSON 参数。
func (state *responseState) completeToolCall(
	event inference.ToolCallCompletedEvent,
) error {
	toolCall, err := state.openToolCall(event.OutputIndex(), event.CallID())
	if err != nil ||
		event.BlockIndex() != 0 ||
		event.Name() != toolCall.name ||
		!bytes.HasPrefix(event.Arguments(), []byte(toolCall.arguments)) {
		return ErrInvalidEventSequence
	}
	toolCall.arguments = string(event.Arguments())
	toolCall.completed = true
	return nil
}

// openToolCall 返回 call ID 匹配且尚未完成的工具调用。
func (state *responseState) openToolCall(
	outputIndex uint32,
	callID string,
) (*chatToolCallState, error) {
	item, err := state.openItem(outputIndex)
	if err != nil ||
		item.kind != inference.OutputItemToolCall ||
		item.toolCall == nil ||
		item.toolCall.completed ||
		item.toolCall.callID != callID {
		return nil, ErrInvalidEventSequence
	}
	return item.toolCall, nil
}

// toolArgumentsSuffix 返回完整参数相对累计增量缺失的后缀。
func (state *responseState) toolArgumentsSuffix(
	outputIndex uint32,
	callID string,
	fullArguments []byte,
) (string, error) {
	toolCall, err := state.openToolCall(outputIndex, callID)
	if err != nil || !bytes.HasPrefix(fullArguments, []byte(toolCall.arguments)) {
		return "", ErrInvalidEventSequence
	}
	return strings.TrimPrefix(string(fullArguments), toolCall.arguments), nil
}
