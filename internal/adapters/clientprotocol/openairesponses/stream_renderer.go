package openairesponses

import (
	"encoding/json"
	"time"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
)

// streamPosition 唯一标识一个输出项内的内容块。
type streamPosition struct {
	outputIndex uint32
	blockIndex  uint32
}

// StreamRenderer 将 Canonical 事件渲染为 OpenAI Responses SSE 事件。
type StreamRenderer struct {
	state                 *responseState
	nextSequence          uint64
	addedItems            map[uint32]struct{}
	addedReasoningSummary map[streamPosition]struct{}
}

// NewStreamRenderer 创建固定响应创建时间的流式 Renderer。
func NewStreamRenderer(
	request inference.Request,
	createdAt time.Time,
) *StreamRenderer {
	return newStreamRenderer(request, defaultResponseProjection(), createdAt, func() time.Time {
		return createdAt
	})
}

// newStreamRenderer 创建由生命周期时钟记录真实完成时间的流式 Renderer。
func newStreamRenderer(
	request inference.Request,
	projection responseProjection,
	createdAt time.Time,
	completionClock func() time.Time,
) *StreamRenderer {
	return &StreamRenderer{
		state: newResponseState(
			request,
			projection,
			createdAt,
			completionClock,
		),
		addedItems:            make(map[uint32]struct{}),
		addedReasoningSummary: make(map[streamPosition]struct{}),
	}
}

// Render 校验并渲染一个 Canonical 事件，返回零个或多个连续 SSE 事件。
func (renderer *StreamRenderer) Render(
	event inference.StreamEvent,
) ([]RenderedEvent, error) {
	if err := validateSupportedResponseEvent(event); err != nil {
		return nil, err
	}
	frames, err := renderer.prepareFrames(event)
	if err != nil {
		return nil, err
	}
	if err := renderer.state.apply(event); err != nil {
		return nil, err
	}
	return renderer.renderPreparedFrames(event, frames)
}

// validateSupportedResponseEvent 在修改状态前拒绝 Responses 没有原生 carrier 的
// Claude redacted_thinking，避免把 Provider 私有数据伪装成 encrypted_content。
func validateSupportedResponseEvent(event inference.StreamEvent) error {
	completed, ok := event.(inference.ReasoningCompletedEvent)
	if ok && completed.Content().ReasoningKind() == inference.ReasoningRedacted {
		return ErrUnsupportedResponseEvent
	}
	return nil
}

// Terminal 表示 Renderer 已收到成功或失败终态。
func (renderer *StreamRenderer) Terminal() bool {
	return renderer != nil &&
		renderer.state != nil &&
		renderer.state.terminal
}

// preparedFrames 保存必须在状态更新前计算的缺失后缀。
type preparedFrames struct {
	textSuffix      string
	argumentsSuffix string
}

// prepareFrames 在终值覆盖累计值前计算必须补发的增量。
func (renderer *StreamRenderer) prepareFrames(
	event inference.StreamEvent,
) (preparedFrames, error) {
	switch typed := event.(type) {
	case inference.TextCompletedEvent:
		suffix, err := renderer.state.textSuffix(
			typed.OutputIndex(),
			typed.BlockIndex(),
			typed.Text(),
		)
		return preparedFrames{textSuffix: suffix}, err
	case inference.RefusalCompletedEvent:
		suffix, err := renderer.state.textSuffix(
			typed.OutputIndex(),
			typed.BlockIndex(),
			typed.Refusal(),
		)
		return preparedFrames{textSuffix: suffix}, err
	case inference.ReasoningCompletedEvent:
		content := typed.Content()
		if content.ReasoningKind() == inference.ReasoningEncrypted {
			return preparedFrames{}, nil
		}
		suffix, err := renderer.state.textSuffix(
			typed.OutputIndex(),
			typed.BlockIndex(),
			content.Text(),
		)
		return preparedFrames{textSuffix: suffix}, err
	case inference.ToolCallCompletedEvent:
		suffix, err := renderer.state.toolArgumentsSuffix(
			typed.OutputIndex(),
			typed.CallID(),
			typed.Arguments(),
		)
		return preparedFrames{argumentsSuffix: suffix}, err
	case inference.WebSearchCompletedEvent:
		return preparedFrames{}, nil
	case inference.URLCitationAddedEvent:
		return preparedFrames{}, nil
	default:
		return preparedFrames{}, nil
	}
}

// renderPreparedFrames 根据已经应用的状态生成对应 Responses 事件。
func (renderer *StreamRenderer) renderPreparedFrames(
	event inference.StreamEvent,
	prepared preparedFrames,
) ([]RenderedEvent, error) {
	switch typed := event.(type) {
	case inference.ResponseStartedEvent:
		return renderer.renderResponseStarted()
	case inference.OutputItemStartedEvent:
		return renderer.renderOutputItemStarted(typed)
	case inference.ContentBlockStartedEvent:
		return renderer.renderContentBlockStarted(typed)
	case inference.TextDeltaEvent:
		return renderer.renderTextDelta(typed, typed.Delta())
	case inference.TextCompletedEvent:
		return renderer.renderTextCompleted(typed, prepared.textSuffix)
	case inference.RefusalDeltaEvent:
		return renderer.renderRefusalDelta(typed, typed.Delta())
	case inference.RefusalCompletedEvent:
		return renderer.renderRefusalCompleted(typed, prepared.textSuffix)
	case inference.ReasoningDeltaEvent:
		return renderer.renderReasoningDelta(typed)
	case inference.ReasoningCompletedEvent:
		return renderer.renderReasoningCompleted(typed, prepared.textSuffix)
	case inference.ToolCallStartedEvent:
		return renderer.renderToolCallStarted(typed)
	case inference.ToolArgumentsDeltaEvent:
		return renderer.renderToolArgumentsDelta(typed, typed.Delta())
	case inference.ToolCallCompletedEvent:
		return renderer.renderToolCallCompleted(typed, prepared.argumentsSuffix)
	case inference.WebSearchCompletedEvent:
		return nil, nil
	case inference.URLCitationAddedEvent:
		return renderer.renderURLCitationAdded(typed)
	case inference.ContentBlockCompletedEvent:
		return renderer.renderContentBlockCompleted(typed)
	case inference.OutputItemCompletedEvent:
		return renderer.renderOutputItemCompleted(typed)
	case inference.UsageUpdatedEvent:
		return nil, nil
	case inference.ResponseCompletedEvent:
		// 终态事件带着 Canonical 停止原因，截断与自然结束必须区分：
		// 渲染成 completed 会让客户端把半截回答当成最终结果。
		return renderer.renderCompletedTerminal(typed.StopReason())
	case inference.ResponseFailedEvent:
		return renderer.renderResponseTerminal("response.failed", statusFailed)
	default:
		return nil, ErrUnsupportedResponseEvent
	}
}

// renderResponseStarted 生成 created 和 in_progress 两个生命周期事件。
func (renderer *StreamRenderer) renderResponseStarted() ([]RenderedEvent, error) {
	response, err := renderer.state.buildResponseWire("in_progress")
	if err != nil {
		return nil, err
	}
	return renderer.renderMany(
		streamEventWireDTO{Type: "response.created", Response: &response},
		streamEventWireDTO{Type: "response.in_progress", Response: &response},
	)
}

// renderOutputItemStarted 生成可立即表达的输出项 added 事件。
func (renderer *StreamRenderer) renderOutputItemStarted(
	event inference.OutputItemStartedEvent,
) ([]RenderedEvent, error) {
	if event.ItemKind() == inference.OutputItemToolCall {
		return nil, nil
	}
	return renderer.renderOutputItemAdded(event.OutputIndex())
}

// renderOutputItemAdded 生成一次输出项 added 快照。
func (renderer *StreamRenderer) renderOutputItemAdded(
	outputIndex uint32,
) ([]RenderedEvent, error) {
	if _, exists := renderer.addedItems[outputIndex]; exists {
		return nil, ErrInvalidEventSequence
	}
	item, err := renderer.state.openItem(outputIndex)
	if err != nil {
		return nil, err
	}
	encoded, err := marshalOutputItem(
		item,
		"in_progress",
		renderer.state.request.IncludeEncryptedReasoning(),
	)
	if err != nil {
		return nil, err
	}
	frames, err := renderer.renderMany(streamEventWireDTO{
		Type:        "response.output_item.added",
		OutputIndex: uint32Pointer(outputIndex),
		Item:        encoded,
	})
	if err != nil {
		return nil, err
	}
	renderer.addedItems[outputIndex] = struct{}{}
	return frames, nil
}

// renderOutputItemCompleted 生成 completed 输出项快照。
func (renderer *StreamRenderer) renderOutputItemCompleted(
	event inference.OutputItemCompletedEvent,
) ([]RenderedEvent, error) {
	if _, exists := renderer.addedItems[event.OutputIndex()]; !exists {
		return nil, ErrInvalidEventSequence
	}
	item, err := renderer.state.item(event.OutputIndex())
	if err != nil {
		return nil, err
	}
	encoded, err := marshalOutputItem(
		item,
		"completed",
		renderer.state.request.IncludeEncryptedReasoning(),
	)
	if err != nil {
		return nil, err
	}
	return renderer.renderMany(streamEventWireDTO{
		Type:        "response.output_item.done",
		OutputIndex: uint32Pointer(event.OutputIndex()),
		Item:        encoded,
	})
}

// renderCompletedTerminal 按停止原因生成 completed 或 incomplete 终态。
func (renderer *StreamRenderer) renderCompletedTerminal(
	reason inference.StopReason,
) ([]RenderedEvent, error) {
	status, _ := terminalStatusFor(reason)
	eventType := "response.completed"
	if status == statusIncomplete {
		eventType = "response.incomplete"
	}
	response, err := renderer.state.buildTerminalResponseWire(
		reason,
		len(renderer.state.items),
	)
	if err != nil {
		return nil, err
	}
	return renderer.renderMany(streamEventWireDTO{
		Type:     eventType,
		Response: &response,
	})
}

// renderResponseTerminal 生成 completed 或 failed 响应终态。
func (renderer *StreamRenderer) renderResponseTerminal(
	eventType string,
	status string,
) ([]RenderedEvent, error) {
	outputCount := len(renderer.state.items)
	if status == "failed" {
		visibleCount, err := renderer.visibleOutputCount()
		if err != nil {
			return nil, err
		}
		outputCount = visibleCount
	}
	// 该路径只服务 failed 终态，没有截断原因可填。
	response, err := renderer.state.buildResponseWireWithOutputCount(
		status,
		outputCount,
		"",
	)
	if err != nil {
		return nil, err
	}
	return renderer.renderMany(streamEventWireDTO{
		Type:     eventType,
		Response: &response,
	})
}

// visibleOutputCount 返回从零开始连续向客户端曝光的输出项数量。
func (renderer *StreamRenderer) visibleOutputCount() (int, error) {
	for index := range len(renderer.addedItems) {
		if _, exists := renderer.addedItems[uint32(index)]; !exists {
			return 0, ErrInvalidEventSequence
		}
	}
	return len(renderer.addedItems), nil
}

// renderMany 为一组 wire DTO 分配连续客户端序号并编码。
func (renderer *StreamRenderer) renderMany(
	events ...streamEventWireDTO,
) ([]RenderedEvent, error) {
	rendered := make([]RenderedEvent, len(events))
	for index := range events {
		events[index].SequenceNumber = renderer.nextSequence + uint64(index)
		data, err := json.Marshal(events[index])
		if err != nil {
			return nil, err
		}
		rendered[index], err = clientprotocol.NewMarshaledEvent(
			events[index].Type,
			data,
		)
		if err != nil {
			return nil, err
		}
	}
	renderer.nextSequence += uint64(len(events))
	return rendered, nil
}

// uint32Pointer 返回索引的独立指针，确保零值不会被 omitempty 丢失。
func uint32Pointer(value uint32) *uint32 {
	return &value
}
