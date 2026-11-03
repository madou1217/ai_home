package anthropicmessages

import (
	"encoding/json"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
)

// streamPosition 唯一标识一个 Canonical 输出项内的内容块。
type streamPosition struct {
	outputIndex uint32
	blockIndex  uint32
}

// preparedFrames 保存必须在状态更新前计算的缺失后缀。
type preparedFrames struct {
	textSuffix      string
	reasoningSuffix reasoningSuffix
	argumentsSuffix string
}

// StreamRenderer 将 Canonical 事件渲染为 Anthropic Messages SSE 事件。
type StreamRenderer struct {
	state          *responseState
	nextBlockIndex uint32
	blockIndexes   map[streamPosition]uint32
}

// NewStreamRenderer 创建严格按 Anthropic 内容索引输出的流式 Renderer。
func NewStreamRenderer(request inference.Request) *StreamRenderer {
	return &StreamRenderer{
		state:        newResponseState(request),
		blockIndexes: make(map[streamPosition]uint32),
	}
}

// Render 校验并渲染一个 Canonical 事件，返回零个或多个 SSE 事件。
func (renderer *StreamRenderer) Render(
	event inference.StreamEvent,
) ([]RenderedEvent, error) {
	if err := validateSupportedResponseEvent(event); err != nil {
		return nil, err
	}
	prepared, err := renderer.prepareFrames(event)
	if err != nil {
		return nil, err
	}
	if err := renderer.state.apply(event); err != nil {
		return nil, err
	}
	return renderer.renderPreparedFrames(event, prepared)
}

// Terminal 表示 Renderer 已收到成功或失败终态。
func (renderer *StreamRenderer) Terminal() bool {
	return renderer != nil &&
		renderer.state != nil &&
		renderer.state.terminal
}

// validateSupportedResponseEvent 在修改状态前拒绝 Messages 无法表达的终态。
// Provider 私有 reasoning 由 Renderer 省略，不能伪造成 Claude 内容块。
func validateSupportedResponseEvent(event inference.StreamEvent) error {
	switch typed := event.(type) {
	case inference.ResponseCompletedEvent:
		if _, err := mapStopReason(typed.StopReason()); err != nil {
			return err
		}
	}
	return nil
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
		if typed.Content().ReasoningKind() != inference.ReasoningThinking {
			return preparedFrames{}, nil
		}
		suffix, err := renderer.state.reasoningCompletionSuffix(typed)
		return preparedFrames{reasoningSuffix: suffix}, err
	case inference.ToolCallCompletedEvent:
		suffix, err := renderer.state.toolArgumentsSuffix(
			typed.OutputIndex(),
			typed.CallID(),
			typed.Arguments(),
		)
		return preparedFrames{argumentsSuffix: suffix}, err
	default:
		return preparedFrames{}, nil
	}
}

// renderPreparedFrames 根据已经应用的状态生成 Messages 事件。
func (renderer *StreamRenderer) renderPreparedFrames(
	event inference.StreamEvent,
	prepared preparedFrames,
) ([]RenderedEvent, error) {
	switch typed := event.(type) {
	case inference.ResponseStartedEvent:
		return renderer.renderResponseStarted()
	case inference.OutputItemStartedEvent:
		return nil, nil
	case inference.ContentBlockStartedEvent:
		return renderer.renderContentBlockStarted(typed)
	case inference.TextDeltaEvent:
		return renderer.renderTextDelta(
			typed.OutputIndex(),
			typed.BlockIndex(),
			typed.Delta(),
		)
	case inference.TextCompletedEvent:
		return renderer.renderTextDelta(
			typed.OutputIndex(),
			typed.BlockIndex(),
			prepared.textSuffix,
		)
	case inference.RefusalDeltaEvent:
		return renderer.renderTextDelta(
			typed.OutputIndex(),
			typed.BlockIndex(),
			typed.Delta(),
		)
	case inference.RefusalCompletedEvent:
		return renderer.renderTextDelta(
			typed.OutputIndex(),
			typed.BlockIndex(),
			prepared.textSuffix,
		)
	case inference.ReasoningDeltaEvent:
		return renderer.renderReasoningDelta(typed)
	case inference.ReasoningCompletedEvent:
		return renderer.renderReasoningCompleted(typed, prepared.reasoningSuffix)
	case inference.ToolCallStartedEvent:
		return renderer.renderToolCallStarted(typed)
	case inference.ToolArgumentsDeltaEvent:
		return renderer.renderToolArgumentsDelta(
			typed.OutputIndex(),
			typed.BlockIndex(),
			typed.Delta(),
		)
	case inference.ToolCallCompletedEvent:
		return renderer.renderToolArgumentsDelta(
			typed.OutputIndex(),
			typed.BlockIndex(),
			prepared.argumentsSuffix,
		)
	case inference.ContentBlockCompletedEvent:
		return renderer.renderContentBlockCompleted(typed)
	case inference.OutputItemCompletedEvent:
		return renderer.renderOutputItemCompleted(typed)
	case inference.UsageUpdatedEvent:
		return nil, nil
	case inference.ResponseCompletedEvent:
		return renderer.renderResponseCompleted()
	case inference.ResponseFailedEvent:
		return renderer.renderResponseFailed()
	default:
		return nil, ErrUnsupportedResponseEvent
	}
}

// renderResponseStarted 生成 Anthropic message_start 生命周期事件。
func (renderer *StreamRenderer) renderResponseStarted() ([]RenderedEvent, error) {
	message := renderer.state.buildStartMessageWire()
	return renderer.renderMany(streamEventWireDTO{
		Type:    "message_start",
		Message: &message,
	})
}

// renderContentBlockStarted 立即输出文本块，reasoning 延迟到具体种类明确时输出。
func (renderer *StreamRenderer) renderContentBlockStarted(
	event inference.ContentBlockStartedEvent,
) ([]RenderedEvent, error) {
	if event.ContentKind() == inference.ContentReasoning {
		return nil, nil
	}
	position := streamPosition{
		outputIndex: event.OutputIndex(),
		blockIndex:  event.BlockIndex(),
	}
	index, err := renderer.allocateBlock(position)
	if err != nil {
		return nil, err
	}
	contentBlock, err := marshalRaw(textBlockWireDTO{
		Type:      "text",
		Text:      "",
		Citations: nil,
	})
	if err != nil {
		return nil, err
	}
	return renderer.renderMany(streamEventWireDTO{
		Type:         "content_block_start",
		Index:        &index,
		ContentBlock: contentBlock,
	})
}

// renderTextDelta 把普通文本或 refusal 渲染为 Messages text_delta。
func (renderer *StreamRenderer) renderTextDelta(
	outputIndex uint32,
	blockIndex uint32,
	delta string,
) ([]RenderedEvent, error) {
	if delta == "" {
		return nil, nil
	}
	index, err := renderer.blockIndex(streamPosition{
		outputIndex: outputIndex,
		blockIndex:  blockIndex,
	})
	if err != nil {
		return nil, err
	}
	wireDelta, err := marshalRaw(textDeltaWireDTO{Type: "text_delta", Text: delta})
	if err != nil {
		return nil, err
	}
	return renderer.renderMany(streamEventWireDTO{
		Type:  "content_block_delta",
		Index: &index,
		Delta: wireDelta,
	})
}

// renderReasoningDelta 输出 Claude thinking/signature，省略无签名摘要。
func (renderer *StreamRenderer) renderReasoningDelta(
	event inference.ReasoningDeltaEvent,
) ([]RenderedEvent, error) {
	if event.DeltaKind() == inference.ReasoningDeltaSummary {
		return nil, nil
	}
	position := streamPosition{
		outputIndex: event.OutputIndex(),
		blockIndex:  event.BlockIndex(),
	}
	startFrames, index, err := renderer.ensureThinkingBlock(position)
	if err != nil {
		return nil, err
	}

	var delta json.RawMessage
	switch event.DeltaKind() {
	case inference.ReasoningDeltaThinking:
		delta, err = marshalRaw(thinkingDeltaWireDTO{
			Type:     "thinking_delta",
			Thinking: event.Delta(),
		})
	case inference.ReasoningDeltaSignature:
		delta, err = marshalRaw(signatureDeltaWireDTO{
			Type:      "signature_delta",
			Signature: event.Delta(),
		})
	default:
		return nil, ErrUnsupportedResponseEvent
	}
	if err != nil {
		return nil, err
	}
	deltaFrames, err := renderer.renderMany(streamEventWireDTO{
		Type:  "content_block_delta",
		Index: &index,
		Delta: delta,
	})
	if err != nil {
		return nil, err
	}
	return append(startFrames, deltaFrames...), nil
}

// renderReasoningCompleted 补齐 thinking/signature，或输出完整 redacted_thinking。
func (renderer *StreamRenderer) renderReasoningCompleted(
	event inference.ReasoningCompletedEvent,
	suffix reasoningSuffix,
) ([]RenderedEvent, error) {
	position := streamPosition{
		outputIndex: event.OutputIndex(),
		blockIndex:  event.BlockIndex(),
	}
	content := event.Content()
	if content.ReasoningKind() == inference.ReasoningSummary ||
		content.ReasoningKind() == inference.ReasoningEncrypted {
		return nil, nil
	}
	if content.ReasoningKind() == inference.ReasoningRedacted {
		index, err := renderer.allocateBlock(position)
		if err != nil {
			return nil, err
		}
		contentBlock, err := marshalRaw(redactedThinkingBlockWireDTO{
			Type: "redacted_thinking",
			Data: content.RedactedData(),
		})
		if err != nil {
			return nil, err
		}
		return renderer.renderMany(streamEventWireDTO{
			Type:         "content_block_start",
			Index:        &index,
			ContentBlock: contentBlock,
		})
	}

	startFrames, index, err := renderer.ensureThinkingBlock(position)
	if err != nil {
		return nil, err
	}
	frames := startFrames
	if suffix.thinking != "" {
		delta, err := marshalRaw(thinkingDeltaWireDTO{
			Type:     "thinking_delta",
			Thinking: suffix.thinking,
		})
		if err != nil {
			return nil, err
		}
		rendered, err := renderer.renderMany(streamEventWireDTO{
			Type:  "content_block_delta",
			Index: &index,
			Delta: delta,
		})
		if err != nil {
			return nil, err
		}
		frames = append(frames, rendered...)
	}
	if suffix.signature != "" {
		delta, err := marshalRaw(signatureDeltaWireDTO{
			Type:      "signature_delta",
			Signature: suffix.signature,
		})
		if err != nil {
			return nil, err
		}
		rendered, err := renderer.renderMany(streamEventWireDTO{
			Type:  "content_block_delta",
			Index: &index,
			Delta: delta,
		})
		if err != nil {
			return nil, err
		}
		frames = append(frames, rendered...)
	}
	return frames, nil
}

// ensureThinkingBlock 在首个 reasoning 事件到达时分配 Messages 内容索引。
func (renderer *StreamRenderer) ensureThinkingBlock(
	position streamPosition,
) ([]RenderedEvent, uint32, error) {
	if index, exists := renderer.blockIndexes[position]; exists {
		return nil, index, nil
	}
	index, err := renderer.allocateBlock(position)
	if err != nil {
		return nil, 0, err
	}
	contentBlock, err := marshalRaw(thinkingBlockWireDTO{
		Type:      "thinking",
		Thinking:  "",
		Signature: "",
	})
	if err != nil {
		return nil, 0, err
	}
	frames, err := renderer.renderMany(streamEventWireDTO{
		Type:         "content_block_start",
		Index:        &index,
		ContentBlock: contentBlock,
	})
	return frames, index, err
}

// renderToolCallStarted 生成 input 为空对象的 tool_use 内容块。
func (renderer *StreamRenderer) renderToolCallStarted(
	event inference.ToolCallStartedEvent,
) ([]RenderedEvent, error) {
	position := streamPosition{
		outputIndex: event.OutputIndex(),
		blockIndex:  event.BlockIndex(),
	}
	index, err := renderer.allocateBlock(position)
	if err != nil {
		return nil, err
	}
	contentBlock, err := marshalRaw(toolUseBlockWireDTO{
		Type:  "tool_use",
		ID:    event.CallID(),
		Name:  event.Name(),
		Input: json.RawMessage(`{}`),
	})
	if err != nil {
		return nil, err
	}
	return renderer.renderMany(streamEventWireDTO{
		Type:         "content_block_start",
		Index:        &index,
		ContentBlock: contentBlock,
	})
}

// renderToolArgumentsDelta 生成工具参数原始 JSON 增量。
func (renderer *StreamRenderer) renderToolArgumentsDelta(
	outputIndex uint32,
	blockIndex uint32,
	delta string,
) ([]RenderedEvent, error) {
	if delta == "" {
		return nil, nil
	}
	index, err := renderer.blockIndex(streamPosition{
		outputIndex: outputIndex,
		blockIndex:  blockIndex,
	})
	if err != nil {
		return nil, err
	}
	wireDelta, err := marshalRaw(inputJSONDeltaWireDTO{
		Type:        "input_json_delta",
		PartialJSON: delta,
	})
	if err != nil {
		return nil, err
	}
	return renderer.renderMany(streamEventWireDTO{
		Type:  "content_block_delta",
		Index: &index,
		Delta: wireDelta,
	})
}

// renderContentBlockCompleted 结束文本或 reasoning 内容块。
func (renderer *StreamRenderer) renderContentBlockCompleted(
	event inference.ContentBlockCompletedEvent,
) ([]RenderedEvent, error) {
	block, err := renderer.state.block(event.OutputIndex(), event.BlockIndex())
	if err != nil {
		return nil, err
	}
	if block.kind == inference.ContentReasoning &&
		(block.reasoningKind == inference.ReasoningSummary ||
			block.reasoningKind == inference.ReasoningEncrypted) {
		return nil, nil
	}
	index, err := renderer.blockIndex(streamPosition{
		outputIndex: event.OutputIndex(),
		blockIndex:  event.BlockIndex(),
	})
	if err != nil {
		return nil, err
	}
	return renderer.renderMany(streamEventWireDTO{
		Type:  "content_block_stop",
		Index: &index,
	})
}

// renderOutputItemCompleted 在工具调用项完成时结束对应 tool_use 内容块。
func (renderer *StreamRenderer) renderOutputItemCompleted(
	event inference.OutputItemCompletedEvent,
) ([]RenderedEvent, error) {
	item, err := renderer.state.item(event.OutputIndex())
	if err != nil {
		return nil, err
	}
	if item.kind != inference.OutputItemToolCall {
		return nil, nil
	}
	index, err := renderer.blockIndex(streamPosition{
		outputIndex: event.OutputIndex(),
		blockIndex:  0,
	})
	if err != nil {
		return nil, err
	}
	return renderer.renderMany(streamEventWireDTO{
		Type:  "content_block_stop",
		Index: &index,
	})
}

// renderResponseCompleted 生成最终 message_delta 和 message_stop。
func (renderer *StreamRenderer) renderResponseCompleted() ([]RenderedEvent, error) {
	stopReason, err := mapStopReason(renderer.state.stopReason)
	if err != nil {
		return nil, err
	}
	delta, err := marshalRaw(messageDeltaWireDTO{
		StopReason:   stopReason,
		StopSequence: optionalString(renderer.state.stopSequence),
		Container:    nil,
	})
	if err != nil {
		return nil, err
	}
	usage := newMessageDeltaUsageWire(renderer.state.usage)
	return renderer.renderMany(
		streamEventWireDTO{
			Type:  "message_delta",
			Delta: delta,
			Usage: &usage,
		},
		streamEventWireDTO{Type: "message_stop"},
	)
}

// renderResponseFailed 生成不会泄露 Provider 原始正文的 error 事件。
func (renderer *StreamRenderer) renderResponseFailed() ([]RenderedEvent, error) {
	wireError := newErrorWire(renderer.state.failure)
	return renderer.renderMany(streamEventWireDTO{
		Type:  "error",
		Error: &wireError,
	})
}

// allocateBlock 按首次曝光顺序分配连续的 Anthropic 内容索引。
func (renderer *StreamRenderer) allocateBlock(position streamPosition) (uint32, error) {
	if _, exists := renderer.blockIndexes[position]; exists {
		return 0, ErrInvalidEventSequence
	}
	index := renderer.nextBlockIndex
	renderer.nextBlockIndex++
	renderer.blockIndexes[position] = index
	return index, nil
}

// blockIndex 返回已向客户端曝光的 Anthropic 内容索引。
func (renderer *StreamRenderer) blockIndex(position streamPosition) (uint32, error) {
	index, exists := renderer.blockIndexes[position]
	if !exists {
		return 0, ErrInvalidEventSequence
	}
	return index, nil
}

// renderMany 编码一组 Messages SSE wire DTO。
func (renderer *StreamRenderer) renderMany(
	events ...streamEventWireDTO,
) ([]RenderedEvent, error) {
	rendered := make([]RenderedEvent, len(events))
	for index, event := range events {
		data, err := json.Marshal(event)
		if err != nil {
			return nil, err
		}
		rendered[index], err = clientprotocol.NewMarshaledEvent(
			event.Type,
			data,
		)
		if err != nil {
			return nil, err
		}
	}
	return rendered, nil
}

// marshalRaw 把类型化 DTO 编码为嵌套 JSON 值。
func marshalRaw(value any) (json.RawMessage, error) {
	return json.Marshal(value)
}
