package responses

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/core/inference"
)

// applyAddedReasoningSnapshot 建立 added 事件已有的 raw 和 summary 块。
func (decoder *responseDecoder) applyAddedReasoningSnapshot(
	outputIndex uint32,
	item *decodedItem,
	wire outputItemDTO,
) error {
	for index, content := range wire.Content {
		if content.Type != "reasoning_text" {
			return ErrInvalidUpstreamResponse
		}
		contentIndex := uint32(index)
		if content.Text == "" {
			_, _, err := decoder.ensureBlock(
				outputIndex,
				reasoningSource("content", contentIndex),
				inference.ContentReasoning,
			)
			if err != nil {
				return err
			}
			continue
		}
		if err := decoder.appendReasoningDelta(
			streamEventDTO{
				OutputIndex:  &outputIndex,
				ContentIndex: &contentIndex,
				ItemID:       item.id,
				Delta:        content.Text,
			},
			"content",
		); err != nil {
			return err
		}
	}
	for index, summary := range wire.Summary {
		if summary.Type != "summary_text" {
			return ErrInvalidUpstreamResponse
		}
		summaryIndex := uint32(index)
		if summary.Text == "" {
			_, _, err := decoder.ensureBlock(
				outputIndex,
				reasoningSource("summary", summaryIndex),
				inference.ContentReasoning,
			)
			if err != nil {
				return err
			}
			continue
		}
		if err := decoder.appendReasoningDelta(
			streamEventDTO{
				OutputIndex:  &outputIndex,
				SummaryIndex: &summaryIndex,
				ItemID:       item.id,
				Delta:        summary.Text,
			},
			"summary",
		); err != nil {
			return err
		}
	}
	return nil
}

// addReasoningPart 为 summary 建立块；part 内容只在 done 时提交。
func (decoder *responseDecoder) addReasoningPart(
	event streamEventDTO,
) error {
	if event.OutputIndex == nil || event.SummaryIndex == nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.validateItemReference(event); err != nil {
		return err
	}
	_, _, err := decoder.ensureBlock(
		*event.OutputIndex,
		reasoningSource("summary", *event.SummaryIndex),
		inference.ContentReasoning,
	)
	return err
}

// appendReasoningDelta 保留 summary 或 raw reasoning 的流式文本。
func (decoder *responseDecoder) appendReasoningDelta(
	event streamEventDTO,
	sourceKind string,
) error {
	sourceIndex, err := reasoningEventIndex(event, sourceKind)
	if err != nil || event.OutputIndex == nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.validateItemReference(event); err != nil {
		return err
	}
	block, blockIndex, err := decoder.ensureBlock(
		*event.OutputIndex,
		reasoningSource(sourceKind, sourceIndex),
		inference.ContentReasoning,
	)
	if err != nil {
		return err
	}
	if event.Delta == "" {
		return nil
	}
	canonical, err := inference.NewReasoningDeltaEvent(
		decoder.nextSequence,
		*event.OutputIndex,
		blockIndex,
		inference.ReasoningDeltaSummary,
		event.Delta,
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.emitEvent(canonical); err != nil {
		return err
	}
	block.text += event.Delta
	return nil
}

// completeReasoningValue 提交一个 summary/raw reasoning 完整文本。
func (decoder *responseDecoder) completeReasoningValue(
	event streamEventDTO,
	sourceKind string,
) error {
	sourceIndex, err := reasoningEventIndex(event, sourceKind)
	if err != nil || event.OutputIndex == nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.validateItemReference(event); err != nil {
		return err
	}
	return decoder.finalizeReasoningBlock(
		*event.OutputIndex,
		reasoningSource(sourceKind, sourceIndex),
		event.Text,
		false,
	)
}

// completeReasoningPart 使用 part 快照完成 summary 块。
func (decoder *responseDecoder) completeReasoningPart(
	event streamEventDTO,
) error {
	var part reasoningSummaryDTO
	if event.OutputIndex == nil ||
		event.SummaryIndex == nil ||
		len(event.Part) == 0 ||
		json.Unmarshal(event.Part, &part) != nil ||
		part.Type != "summary_text" {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.validateItemReference(event); err != nil {
		return err
	}
	return decoder.finalizeReasoningBlock(
		*event.OutputIndex,
		reasoningSource("summary", *event.SummaryIndex),
		part.Text,
		true,
	)
}

// finalizeReasoningBlock 补齐 reasoning 后缀并提交完整摘要值。
func (decoder *responseDecoder) finalizeReasoningBlock(
	outputIndex uint32,
	source string,
	full string,
	completeBlock bool,
) error {
	block, blockIndex, err := decoder.ensureBlock(
		outputIndex,
		source,
		inference.ContentReasoning,
	)
	if err != nil {
		return err
	}
	if block.valueComplete {
		if block.text != full {
			return ErrInvalidUpstreamResponse
		}
		if completeBlock {
			return decoder.finishBlock(outputIndex, blockIndex, block)
		}
		return nil
	}
	if full == "" || !strings.HasPrefix(full, block.text) {
		return ErrInvalidUpstreamResponse
	}
	suffix := strings.TrimPrefix(full, block.text)
	if suffix != "" {
		delta, constructErr := inference.NewReasoningDeltaEvent(
			decoder.nextSequence,
			outputIndex,
			blockIndex,
			inference.ReasoningDeltaSummary,
			suffix,
		)
		if constructErr != nil {
			return ErrInvalidUpstreamResponse
		}
		if err := decoder.emitEvent(delta); err != nil {
			return err
		}
		block.text += suffix
	}
	content, err := inference.NewReasoningSummaryContent(full)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	completed, err := inference.NewReasoningCompletedEvent(
		decoder.nextSequence,
		outputIndex,
		blockIndex,
		content,
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.emitEvent(completed); err != nil {
		return err
	}
	block.text = full
	block.valueComplete = true
	if completeBlock {
		return decoder.finishBlock(outputIndex, blockIndex, block)
	}
	return nil
}

// reconcileReasoning 重建 raw、summary 和 encrypted reasoning 块。
func (decoder *responseDecoder) reconcileReasoning(
	outputIndex uint32,
	item *decodedItem,
	wire outputItemDTO,
) error {
	for index, content := range wire.Content {
		if content.Type != "reasoning_text" {
			return ErrInvalidUpstreamResponse
		}
		if err := decoder.finalizeReasoningBlock(
			outputIndex,
			reasoningSource("content", uint32(index)),
			content.Text,
			true,
		); err != nil {
			return err
		}
	}
	for index, summary := range wire.Summary {
		if summary.Type != "summary_text" {
			return ErrInvalidUpstreamResponse
		}
		if err := decoder.finalizeReasoningBlock(
			outputIndex,
			reasoningSource("summary", uint32(index)),
			summary.Text,
			true,
		); err != nil {
			return err
		}
	}
	if wire.EncryptedContent != "" {
		if err := decoder.finalizeEncryptedReasoning(
			outputIndex,
			wire.EncryptedContent,
		); err != nil {
			return err
		}
	}
	if reasoningBlockCount(wire) != len(item.blocks) {
		return ErrInvalidUpstreamResponse
	}
	return decoder.ensureAllBlocksCompleted(item)
}

// finalizeEncryptedReasoning 提交不可解释的加密连续性。
func (decoder *responseDecoder) finalizeEncryptedReasoning(
	outputIndex uint32,
	data string,
) error {
	block, blockIndex, err := decoder.ensureBlock(
		outputIndex,
		"encrypted",
		inference.ContentReasoning,
	)
	if err != nil {
		return err
	}
	if block.valueComplete {
		if block.text != data {
			return ErrInvalidUpstreamResponse
		}
		return decoder.finishBlock(outputIndex, blockIndex, block)
	}
	content, err := inference.NewEncryptedReasoningContent(data)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	event, err := inference.NewReasoningCompletedEvent(
		decoder.nextSequence,
		outputIndex,
		blockIndex,
		content,
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.emitEvent(event); err != nil {
		return err
	}
	block.text = data
	block.valueComplete = true
	return decoder.finishBlock(outputIndex, blockIndex, block)
}

// verifyCompletedReasoningItem 校验重复终态中的已知 reasoning 块。
func verifyCompletedReasoningItem(
	item *decodedItem,
	wire outputItemDTO,
) error {
	if reasoningBlockCount(wire) != len(item.blocks) {
		return ErrInvalidUpstreamResponse
	}
	for index, content := range wire.Content {
		if content.Type != "reasoning_text" {
			return ErrInvalidUpstreamResponse
		}
		if err := verifyCompletedBlock(
			item,
			reasoningSource("content", uint32(index)),
			inference.ContentReasoning,
			content.Text,
		); err != nil {
			return err
		}
	}
	for index, summary := range wire.Summary {
		if summary.Type != "summary_text" {
			return ErrInvalidUpstreamResponse
		}
		if err := verifyCompletedBlock(
			item,
			reasoningSource("summary", uint32(index)),
			inference.ContentReasoning,
			summary.Text,
		); err != nil {
			return err
		}
	}
	if wire.EncryptedContent != "" {
		return verifyCompletedBlock(
			item,
			"encrypted",
			inference.ContentReasoning,
			wire.EncryptedContent,
		)
	}
	return nil
}

// reasoningBlockCount 计算终态 reasoning 快照应包含的 Canonical 内容块数量。
func reasoningBlockCount(wire outputItemDTO) int {
	count := len(wire.Content) + len(wire.Summary)
	if wire.EncryptedContent != "" {
		count++
	}
	return count
}

// reasoningEventIndex 返回 summary_index 或 content_index。
func reasoningEventIndex(
	event streamEventDTO,
	sourceKind string,
) (uint32, error) {
	switch sourceKind {
	case "summary":
		if event.SummaryIndex != nil {
			return *event.SummaryIndex, nil
		}
	case "content":
		if event.ContentIndex != nil {
			return *event.ContentIndex, nil
		}
	}
	return 0, ErrInvalidUpstreamResponse
}

// reasoningSource 创建区分 raw 与 summary 的块键。
func reasoningSource(kind string, index uint32) string {
	return fmt.Sprintf("reasoning:%s:%d", kind, index)
}
