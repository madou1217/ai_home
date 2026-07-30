package openaichatcompletions

import (
	"encoding/json"
	"time"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
)

// StreamRenderer 将 Canonical 事件渲染为 Chat Completions data-only SSE。
type StreamRenderer struct {
	// state 是本次响应独占的严格事件状态机。
	state *responseState
}

// NewStreamRenderer 创建固定响应创建时间的流式 Renderer。
func NewStreamRenderer(
	request inference.Request,
	createdAt time.Time,
) *StreamRenderer {
	return &StreamRenderer{state: newResponseState(request, createdAt)}
}

// Render 校验并渲染一个 Canonical 事件。
func (renderer *StreamRenderer) Render(
	event inference.StreamEvent,
) ([]RenderedEvent, error) {
	if err := validateSupportedResponseEvent(event); err != nil {
		return nil, err
	}
	prepared, err := renderer.prepare(event)
	if err != nil {
		return nil, err
	}
	if err := renderer.state.apply(event); err != nil {
		return nil, err
	}
	return renderer.renderApplied(event, prepared)
}

// Terminal 表示 Renderer 已收到成功或失败终态。
func (renderer *StreamRenderer) Terminal() bool {
	return renderer != nil &&
		renderer.state != nil &&
		renderer.state.terminal
}

// preparedDelta 保存必须在终值覆盖累计值前计算的缺失后缀。
type preparedDelta struct {
	// text 是完整文本尚未通过增量发送的后缀。
	text string
	// arguments 是完整工具参数尚未发送的后缀。
	arguments string
}

// prepare 在状态更新前计算完整终值尚未流出的后缀。
func (renderer *StreamRenderer) prepare(
	event inference.StreamEvent,
) (preparedDelta, error) {
	switch typed := event.(type) {
	case inference.TextCompletedEvent:
		suffix, err := renderer.state.textSuffix(
			typed.OutputIndex(),
			typed.BlockIndex(),
			typed.Text(),
		)
		return preparedDelta{text: suffix}, err
	case inference.RefusalCompletedEvent:
		suffix, err := renderer.state.textSuffix(
			typed.OutputIndex(),
			typed.BlockIndex(),
			typed.Refusal(),
		)
		return preparedDelta{text: suffix}, err
	case inference.ReasoningCompletedEvent:
		suffix, err := renderer.state.textSuffix(
			typed.OutputIndex(),
			typed.BlockIndex(),
			typed.Content().Text(),
		)
		return preparedDelta{text: suffix}, err
	case inference.ToolCallCompletedEvent:
		suffix, err := renderer.state.toolArgumentsSuffix(
			typed.OutputIndex(),
			typed.CallID(),
			typed.Arguments(),
		)
		return preparedDelta{arguments: suffix}, err
	default:
		return preparedDelta{}, nil
	}
}

// renderApplied 根据已经成功应用的状态生成零个或多个 SSE 帧。
func (renderer *StreamRenderer) renderApplied(
	event inference.StreamEvent,
	prepared preparedDelta,
) ([]RenderedEvent, error) {
	switch typed := event.(type) {
	case inference.ResponseStartedEvent:
		return renderer.renderDelta(chatDeltaWire{Role: "assistant"})
	case inference.TextDeltaEvent:
		return renderer.renderDelta(chatDeltaWire{Content: typed.Delta()})
	case inference.TextCompletedEvent:
		return renderer.renderTextSuffix(
			prepared.text,
			func(value string) chatDeltaWire {
				return chatDeltaWire{Content: value}
			},
		)
	case inference.RefusalDeltaEvent:
		return renderer.renderDelta(chatDeltaWire{Refusal: typed.Delta()})
	case inference.RefusalCompletedEvent:
		return renderer.renderTextSuffix(
			prepared.text,
			func(value string) chatDeltaWire {
				return chatDeltaWire{Refusal: value}
			},
		)
	case inference.ReasoningDeltaEvent:
		return renderer.renderDelta(chatDeltaWire{
			ReasoningContent: typed.Delta(),
		})
	case inference.ReasoningCompletedEvent:
		return renderer.renderTextSuffix(
			prepared.text,
			func(value string) chatDeltaWire {
				return chatDeltaWire{ReasoningContent: value}
			},
		)
	case inference.ToolCallStartedEvent:
		return renderer.renderToolStarted(typed)
	case inference.ToolArgumentsDeltaEvent:
		return renderer.renderToolArguments(typed.OutputIndex(), typed.Delta())
	case inference.ToolCallCompletedEvent:
		return renderer.renderToolArguments(typed.OutputIndex(), prepared.arguments)
	case inference.ResponseCompletedEvent:
		return renderer.renderCompleted()
	case inference.ResponseFailedEvent:
		return renderer.renderFailed(typed.Failure())
	case inference.OutputItemStartedEvent,
		inference.ContentBlockStartedEvent,
		inference.ContentBlockCompletedEvent,
		inference.OutputItemCompletedEvent,
		inference.UsageUpdatedEvent:
		return nil, nil
	default:
		return nil, ErrUnsupportedResponseEvent
	}
}

// renderTextSuffix 只在完整终值包含未流出内容时生成补充帧。
func (renderer *StreamRenderer) renderTextSuffix(
	suffix string,
	buildDelta func(string) chatDeltaWire,
) ([]RenderedEvent, error) {
	if suffix == "" {
		return nil, nil
	}
	return renderer.renderDelta(buildDelta(suffix))
}

// renderToolStarted 生成包含 ID、类型、名称和明确空参数的首帧。
func (renderer *StreamRenderer) renderToolStarted(
	event inference.ToolCallStartedEvent,
) ([]RenderedEvent, error) {
	toolCall, err := renderer.toolCall(event.OutputIndex())
	if err != nil {
		return nil, err
	}
	emptyArguments := ""
	return renderer.renderDelta(chatDeltaWire{
		ToolCalls: []chatToolCallDeltaWire{{
			Index: toolCall.index,
			ID:    toolCall.callID,
			Type:  "function",
			Function: chatFunctionCallDeltaWire{
				Name:      stringPointer(toolCall.name),
				Arguments: &emptyArguments,
			},
		}},
	})
}

// renderToolArguments 生成属于同一工具序号的参数增量。
func (renderer *StreamRenderer) renderToolArguments(
	outputIndex uint32,
	arguments string,
) ([]RenderedEvent, error) {
	if arguments == "" {
		return nil, nil
	}
	toolCall, err := renderer.toolCall(outputIndex)
	if err != nil {
		return nil, err
	}
	return renderer.renderDelta(chatDeltaWire{
		ToolCalls: []chatToolCallDeltaWire{{
			Index: toolCall.index,
			Function: chatFunctionCallDeltaWire{
				Arguments: stringPointer(arguments),
			},
		}},
	})
}

// toolCall 返回指定输出项已经开始的函数调用。
func (renderer *StreamRenderer) toolCall(
	outputIndex uint32,
) (*chatToolCallState, error) {
	if int(outputIndex) >= len(renderer.state.items) {
		return nil, ErrInvalidEventSequence
	}
	toolCall := renderer.state.items[outputIndex].toolCall
	if toolCall == nil {
		return nil, ErrInvalidEventSequence
	}
	return toolCall, nil
}

// renderDelta 生成一个单 choice Chat 增量帧。
func (renderer *StreamRenderer) renderDelta(
	delta chatDeltaWire,
) ([]RenderedEvent, error) {
	frame, err := renderer.renderJSON(chatChunkWire{
		ID:      renderer.state.responseID,
		Object:  "chat.completion.chunk",
		Created: renderer.state.createdAt,
		Model:   renderer.state.model,
		Choices: []chatChunkChoice{{
			Index: 0,
			Delta: delta,
		}},
	})
	if err != nil {
		return nil, err
	}
	return []RenderedEvent{frame}, nil
}

// renderCompleted 生成 finish_reason、可选 usage 尾块和 `[DONE]`。
func (renderer *StreamRenderer) renderCompleted() ([]RenderedEvent, error) {
	finishReason, err := mapFinishReason(renderer.state.stopReason)
	if err != nil {
		return nil, err
	}
	finish, err := renderer.renderJSON(chatChunkWire{
		ID:      renderer.state.responseID,
		Object:  "chat.completion.chunk",
		Created: renderer.state.createdAt,
		Model:   renderer.state.model,
		Choices: []chatChunkChoice{{
			Index:        0,
			Delta:        chatDeltaWire{},
			FinishReason: &finishReason,
		}},
	})
	if err != nil {
		return nil, err
	}
	frames := []RenderedEvent{finish}
	if renderer.state.request.IncludeUsageInStream() {
		usage := newChatUsageWire(renderer.state.usage)
		usageFrame, renderErr := renderer.renderJSON(chatChunkWire{
			ID:      renderer.state.responseID,
			Object:  "chat.completion.chunk",
			Created: renderer.state.createdAt,
			Model:   renderer.state.model,
			Choices: []chatChunkChoice{},
			Usage:   &usage,
		})
		if renderErr != nil {
			return nil, renderErr
		}
		frames = append(frames, usageFrame)
	}
	done, err := clientprotocol.NewLiteralDataEvent("[DONE]")
	if err != nil {
		return nil, err
	}
	return append(frames, done), nil
}

// renderFailed 生成低敏错误对象并以 `[DONE]` 结束已提交的流。
func (renderer *StreamRenderer) renderFailed(
	failure inference.ResponseFailure,
) ([]RenderedEvent, error) {
	errorFrame, err := renderer.renderJSON(chatErrorEnvelopeWire{
		Error: chatErrorWire{
			Type:    "server_error",
			Code:    failure.Code(),
			Message: failure.SafeMessage(),
		},
	})
	if err != nil {
		return nil, err
	}
	done, err := clientprotocol.NewLiteralDataEvent("[DONE]")
	if err != nil {
		return nil, err
	}
	return []RenderedEvent{errorFrame, done}, nil
}

// renderJSON 编码一个不带 event 名称的紧凑 JSON SSE 帧。
func (renderer *StreamRenderer) renderJSON(value any) (RenderedEvent, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return RenderedEvent{}, err
	}
	return clientprotocol.NewMarshaledDataEvent(data)
}
