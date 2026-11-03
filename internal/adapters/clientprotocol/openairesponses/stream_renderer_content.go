package openairesponses

import (
	"encoding/json"

	"github.com/madou1217/ai_home/core/inference"
)

// renderContentBlockStarted 生成文本或拒绝内容块 added 事件。
func (renderer *StreamRenderer) renderContentBlockStarted(
	event inference.ContentBlockStartedEvent,
) ([]RenderedEvent, error) {
	var partValue any
	switch event.ContentKind() {
	case inference.ContentText:
		partValue = outputTextWireDTO{
			Type:        "output_text",
			Text:        "",
			Annotations: []json.RawMessage{},
		}
	case inference.ContentRefusal:
		partValue = refusalWireDTO{Type: "refusal", Refusal: ""}
	case inference.ContentReasoning:
		return nil, nil
	default:
		return nil, ErrUnsupportedResponseEvent
	}
	part, err := marshalPart(partValue)
	if err != nil {
		return nil, err
	}
	item, err := renderer.state.openItem(event.OutputIndex())
	if err != nil {
		return nil, err
	}
	return renderer.renderMany(streamEventWireDTO{
		Type:         "response.content_part.added",
		OutputIndex:  uint32Pointer(event.OutputIndex()),
		ContentIndex: uint32Pointer(event.BlockIndex()),
		ItemID:       item.id,
		Part:         part,
	})
}

// renderTextDelta 生成一个 output_text 增量事件。
func (renderer *StreamRenderer) renderTextDelta(
	event inference.TextDeltaEvent,
	delta string,
) ([]RenderedEvent, error) {
	return renderer.renderContentDelta(
		"response.output_text.delta",
		event.OutputIndex(),
		event.BlockIndex(),
		delta,
	)
}

// renderTextCompleted 补齐缺失增量后生成 output_text.done。
func (renderer *StreamRenderer) renderTextCompleted(
	event inference.TextCompletedEvent,
	suffix string,
) ([]RenderedEvent, error) {
	frames, err := renderer.renderOptionalContentDelta(
		"response.output_text.delta",
		event.OutputIndex(),
		event.BlockIndex(),
		suffix,
	)
	if err != nil {
		return nil, err
	}
	item, err := renderer.state.openItem(event.OutputIndex())
	if err != nil {
		return nil, err
	}
	done, err := renderer.renderMany(streamEventWireDTO{
		Type:         "response.output_text.done",
		OutputIndex:  uint32Pointer(event.OutputIndex()),
		ContentIndex: uint32Pointer(event.BlockIndex()),
		ItemID:       item.id,
		Text:         event.Text(),
	})
	return append(frames, done...), err
}

// renderURLCitationAdded 生成 Responses 标准的网页引用增量事件。
func (renderer *StreamRenderer) renderURLCitationAdded(
	event inference.URLCitationAddedEvent,
) ([]RenderedEvent, error) {
	item, err := renderer.state.openItem(event.OutputIndex())
	if err != nil {
		return nil, err
	}
	block, err := renderer.state.block(event.OutputIndex(), event.BlockIndex())
	if err != nil || len(block.citations) == 0 {
		return nil, ErrInvalidEventSequence
	}
	annotationIndex := uint32(len(block.citations) - 1)
	annotation, err := json.Marshal(newURLCitationWire(event.Citation()))
	if err != nil {
		return nil, ErrUnsupportedResponseEvent
	}
	return renderer.renderMany(streamEventWireDTO{
		Type:            "response.output_text.annotation.added",
		OutputIndex:     uint32Pointer(event.OutputIndex()),
		ContentIndex:    uint32Pointer(event.BlockIndex()),
		ItemID:          item.id,
		AnnotationIndex: uint32Pointer(annotationIndex),
		Annotation:      annotation,
	})
}

// renderRefusalDelta 生成一个 refusal 增量事件。
func (renderer *StreamRenderer) renderRefusalDelta(
	event inference.RefusalDeltaEvent,
	delta string,
) ([]RenderedEvent, error) {
	return renderer.renderContentDelta(
		"response.refusal.delta",
		event.OutputIndex(),
		event.BlockIndex(),
		delta,
	)
}

// renderRefusalCompleted 补齐缺失增量后生成 refusal.done。
func (renderer *StreamRenderer) renderRefusalCompleted(
	event inference.RefusalCompletedEvent,
	suffix string,
) ([]RenderedEvent, error) {
	frames, err := renderer.renderOptionalContentDelta(
		"response.refusal.delta",
		event.OutputIndex(),
		event.BlockIndex(),
		suffix,
	)
	if err != nil {
		return nil, err
	}
	item, err := renderer.state.openItem(event.OutputIndex())
	if err != nil {
		return nil, err
	}
	done, err := renderer.renderMany(streamEventWireDTO{
		Type:         "response.refusal.done",
		OutputIndex:  uint32Pointer(event.OutputIndex()),
		ContentIndex: uint32Pointer(event.BlockIndex()),
		ItemID:       item.id,
		Refusal:      event.Refusal(),
	})
	return append(frames, done...), err
}

// renderContentBlockCompleted 生成 message part.done 或 reasoning part.done。
func (renderer *StreamRenderer) renderContentBlockCompleted(
	event inference.ContentBlockCompletedEvent,
) ([]RenderedEvent, error) {
	item, err := renderer.state.openItem(event.OutputIndex())
	if err != nil {
		return nil, err
	}
	block, err := renderer.state.block(event.OutputIndex(), event.BlockIndex())
	if err != nil {
		return nil, err
	}
	switch block.kind {
	case inference.ContentText, inference.ContentRefusal:
		part, marshalErr := marshalMessagePart(block)
		if marshalErr != nil {
			return nil, marshalErr
		}
		return renderer.renderMany(streamEventWireDTO{
			Type:         "response.content_part.done",
			OutputIndex:  uint32Pointer(event.OutputIndex()),
			ContentIndex: uint32Pointer(event.BlockIndex()),
			ItemID:       item.id,
			Part:         part,
		})
	case inference.ContentReasoning:
		return renderer.renderReasoningSummaryPartDone(event, item, block)
	default:
		return nil, ErrUnsupportedResponseEvent
	}
}

// renderContentDelta 生成带输出项和内容索引的增量事件。
func (renderer *StreamRenderer) renderContentDelta(
	eventType string,
	outputIndex uint32,
	blockIndex uint32,
	delta string,
) ([]RenderedEvent, error) {
	item, err := renderer.state.openItem(outputIndex)
	if err != nil {
		return nil, err
	}
	return renderer.renderMany(streamEventWireDTO{
		Type:         eventType,
		OutputIndex:  uint32Pointer(outputIndex),
		ContentIndex: uint32Pointer(blockIndex),
		ItemID:       item.id,
		Delta:        delta,
	})
}

// renderOptionalContentDelta 在后缀非空时生成一个补偿增量。
func (renderer *StreamRenderer) renderOptionalContentDelta(
	eventType string,
	outputIndex uint32,
	blockIndex uint32,
	suffix string,
) ([]RenderedEvent, error) {
	if suffix == "" {
		return nil, nil
	}
	return renderer.renderContentDelta(eventType, outputIndex, blockIndex, suffix)
}

// marshalPart 编码一个只属于 Responses wire 边界的内容 DTO。
func marshalPart(value any) (json.RawMessage, error) {
	return json.Marshal(value)
}
