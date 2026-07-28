package openairesponses

import "github.com/madou1217/ai_home/core/inference"

// renderReasoningDelta 确保 summary part 已建立，再生成摘要增量。
func (renderer *StreamRenderer) renderReasoningDelta(
	event inference.ReasoningDeltaEvent,
) ([]RenderedEvent, error) {
	frames, err := renderer.ensureReasoningSummaryAdded(
		event.OutputIndex(),
		event.BlockIndex(),
	)
	if err != nil {
		return nil, err
	}
	delta, err := renderer.renderReasoningSummaryDelta(
		event.OutputIndex(),
		event.BlockIndex(),
		event.Delta(),
	)
	return append(frames, delta...), err
}

// renderReasoningCompleted 生成摘要的缺失增量和 text.done。
func (renderer *StreamRenderer) renderReasoningCompleted(
	event inference.ReasoningCompletedEvent,
	suffix string,
) ([]RenderedEvent, error) {
	content := event.Content()
	if content.ReasoningKind() == inference.ReasoningEncrypted {
		return nil, nil
	}
	frames, err := renderer.ensureReasoningSummaryAdded(
		event.OutputIndex(),
		event.BlockIndex(),
	)
	if err != nil {
		return nil, err
	}
	if suffix != "" {
		delta, deltaErr := renderer.renderReasoningSummaryDelta(
			event.OutputIndex(),
			event.BlockIndex(),
			suffix,
		)
		if deltaErr != nil {
			return nil, deltaErr
		}
		frames = append(frames, delta...)
	}
	item, err := renderer.state.openItem(event.OutputIndex())
	if err != nil {
		return nil, err
	}
	done, err := renderer.renderMany(streamEventWireDTO{
		Type:         "response.reasoning_summary_text.done",
		OutputIndex:  uint32Pointer(event.OutputIndex()),
		SummaryIndex: uint32Pointer(event.BlockIndex()),
		ItemID:       item.id,
		Text:         content.Text(),
	})
	return append(frames, done...), err
}

// ensureReasoningSummaryAdded 为指定摘要只生成一次 part.added。
func (renderer *StreamRenderer) ensureReasoningSummaryAdded(
	outputIndex uint32,
	blockIndex uint32,
) ([]RenderedEvent, error) {
	position := streamPosition{outputIndex: outputIndex, blockIndex: blockIndex}
	if _, exists := renderer.addedReasoningSummary[position]; exists {
		return nil, nil
	}
	item, err := renderer.state.openItem(outputIndex)
	if err != nil {
		return nil, err
	}
	part, err := marshalPart(reasoningSummaryWireDTO{Type: "summary_text", Text: ""})
	if err != nil {
		return nil, err
	}
	frames, err := renderer.renderMany(streamEventWireDTO{
		Type:         "response.reasoning_summary_part.added",
		OutputIndex:  uint32Pointer(outputIndex),
		SummaryIndex: uint32Pointer(blockIndex),
		ItemID:       item.id,
		Part:         part,
	})
	if err != nil {
		return nil, err
	}
	renderer.addedReasoningSummary[position] = struct{}{}
	return frames, nil
}

// renderReasoningSummaryDelta 生成一个 reasoning summary 文本增量。
func (renderer *StreamRenderer) renderReasoningSummaryDelta(
	outputIndex uint32,
	blockIndex uint32,
	delta string,
) ([]RenderedEvent, error) {
	item, err := renderer.state.openItem(outputIndex)
	if err != nil {
		return nil, err
	}
	return renderer.renderMany(streamEventWireDTO{
		Type:         "response.reasoning_summary_text.delta",
		OutputIndex:  uint32Pointer(outputIndex),
		SummaryIndex: uint32Pointer(blockIndex),
		ItemID:       item.id,
		Delta:        delta,
	})
}

// renderReasoningSummaryPartDone 生成已完成的 reasoning summary part。
func (renderer *StreamRenderer) renderReasoningSummaryPartDone(
	event inference.ContentBlockCompletedEvent,
	item *outputItemState,
	block *contentBlockState,
) ([]RenderedEvent, error) {
	if block.reasoningKind == inference.ReasoningEncrypted {
		return nil, nil
	}
	position := streamPosition{
		outputIndex: event.OutputIndex(),
		blockIndex:  event.BlockIndex(),
	}
	if _, exists := renderer.addedReasoningSummary[position]; !exists {
		return nil, ErrInvalidEventSequence
	}
	part, err := marshalPart(reasoningSummaryWireDTO{
		Type: "summary_text",
		Text: block.text,
	})
	if err != nil {
		return nil, err
	}
	return renderer.renderMany(streamEventWireDTO{
		Type:         "response.reasoning_summary_part.done",
		OutputIndex:  uint32Pointer(event.OutputIndex()),
		SummaryIndex: uint32Pointer(event.BlockIndex()),
		ItemID:       item.id,
		Part:         part,
	})
}
