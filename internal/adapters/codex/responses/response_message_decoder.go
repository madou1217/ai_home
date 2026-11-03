package responses

import (
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/core/inference"
)

// applyAddedMessageSnapshot 建立 added 事件已经声明的 message 内容块。
func (decoder *responseDecoder) applyAddedMessageSnapshot(
	outputIndex uint32,
	item *decodedItem,
	wire outputItemDTO,
) error {
	for index, content := range wire.Content {
		kind, err := messageContentKind(content.Type)
		if err != nil {
			return err
		}
		value := content.Text
		if kind == inference.ContentRefusal {
			value = content.Refusal
		}
		contentIndex := uint32(index)
		if value == "" {
			_, _, err = decoder.ensureBlock(
				outputIndex,
				messageSource(contentIndex),
				kind,
			)
			if err != nil {
				return err
			}
			continue
		}
		if err := decoder.appendMessageDelta(
			streamEventDTO{
				OutputIndex:  &outputIndex,
				ContentIndex: &contentIndex,
				ItemID:       item.id,
				Delta:        value,
			},
			kind,
		); err != nil {
			return err
		}
	}
	return nil
}

// addContentPart 为 message 内容建立稳定块索引。
func (decoder *responseDecoder) addContentPart(
	event streamEventDTO,
) error {
	part, err := decodeOutputContent(event.Part)
	if err != nil ||
		event.OutputIndex == nil ||
		event.ContentIndex == nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.validateItemReference(event); err != nil {
		return err
	}
	kind, err := messageContentKind(part.Type)
	if err != nil {
		return err
	}
	_, _, err = decoder.ensureBlock(
		*event.OutputIndex,
		messageSource(*event.ContentIndex),
		kind,
	)
	return err
}

// appendMessageDelta 追加文本或拒绝增量。
func (decoder *responseDecoder) appendMessageDelta(
	event streamEventDTO,
	kind inference.ContentKind,
) error {
	if event.OutputIndex == nil || event.ContentIndex == nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.validateItemReference(event); err != nil {
		return err
	}
	block, blockIndex, err := decoder.ensureBlock(
		*event.OutputIndex,
		messageSource(*event.ContentIndex),
		kind,
	)
	if err != nil {
		return err
	}
	if event.Delta == "" {
		return nil
	}
	canonical, err := newMessageDeltaEvent(
		decoder.nextSequence,
		*event.OutputIndex,
		blockIndex,
		event.Delta,
		kind,
	)
	if err != nil {
		return err
	}
	if err := decoder.emitEvent(canonical); err != nil {
		return err
	}
	block.text += event.Delta
	return nil
}

// completeMessageValue 保存上游提供的完整文本终值。
func (decoder *responseDecoder) completeMessageValue(
	event streamEventDTO,
	kind inference.ContentKind,
) error {
	if event.OutputIndex == nil || event.ContentIndex == nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.validateItemReference(event); err != nil {
		return err
	}
	full := event.Text
	if kind == inference.ContentRefusal {
		full = event.Refusal
	}
	return decoder.finalizeMessageBlock(
		*event.OutputIndex,
		messageSource(*event.ContentIndex),
		kind,
		full,
		false,
	)
}

// completeContentPart 用 part 快照补齐缺失增量并完成内容块。
func (decoder *responseDecoder) completeContentPart(
	event streamEventDTO,
) error {
	part, err := decodeOutputContent(event.Part)
	if err != nil ||
		event.OutputIndex == nil ||
		event.ContentIndex == nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.validateItemReference(event); err != nil {
		return err
	}
	kind, err := messageContentKind(part.Type)
	if err != nil {
		return err
	}
	value := part.Text
	if kind == inference.ContentRefusal {
		value = part.Refusal
	}
	return decoder.finalizeMessageBlock(
		*event.OutputIndex,
		messageSource(*event.ContentIndex),
		kind,
		value,
		true,
	)
}

// finalizeMessageBlock 补齐缺失增量、提交终值并可选完成块。
func (decoder *responseDecoder) finalizeMessageBlock(
	outputIndex uint32,
	source string,
	kind inference.ContentKind,
	full string,
	completeBlock bool,
) error {
	block, blockIndex, err := decoder.ensureBlock(
		outputIndex,
		source,
		kind,
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
		delta, err := newMessageDeltaEvent(
			decoder.nextSequence,
			outputIndex,
			blockIndex,
			suffix,
			kind,
		)
		if err != nil {
			return err
		}
		if err := decoder.emitEvent(delta); err != nil {
			return err
		}
		block.text += suffix
	}
	completed, err := newMessageCompletedEvent(
		decoder.nextSequence,
		outputIndex,
		blockIndex,
		full,
		kind,
	)
	if err != nil {
		return err
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

// newMessageDeltaEvent 创建文本或拒绝增量联合值。
func newMessageDeltaEvent(
	sequence uint64,
	outputIndex uint32,
	blockIndex uint32,
	delta string,
	kind inference.ContentKind,
) (inference.StreamEvent, error) {
	switch kind {
	case inference.ContentText:
		event, err := inference.NewTextDeltaEvent(
			sequence,
			outputIndex,
			blockIndex,
			delta,
		)
		if err != nil {
			return nil, ErrInvalidUpstreamResponse
		}
		return event, nil
	case inference.ContentRefusal:
		event, err := inference.NewRefusalDeltaEvent(
			sequence,
			outputIndex,
			blockIndex,
			delta,
		)
		if err != nil {
			return nil, ErrInvalidUpstreamResponse
		}
		return event, nil
	default:
		return nil, ErrInvalidUpstreamResponse
	}
}

// newMessageCompletedEvent 创建文本或拒绝终值联合值。
func newMessageCompletedEvent(
	sequence uint64,
	outputIndex uint32,
	blockIndex uint32,
	full string,
	kind inference.ContentKind,
) (inference.StreamEvent, error) {
	switch kind {
	case inference.ContentText:
		event, err := inference.NewTextCompletedEvent(
			sequence,
			outputIndex,
			blockIndex,
			full,
		)
		if err != nil {
			return nil, ErrInvalidUpstreamResponse
		}
		return event, nil
	case inference.ContentRefusal:
		event, err := inference.NewRefusalCompletedEvent(
			sequence,
			outputIndex,
			blockIndex,
			full,
		)
		if err != nil {
			return nil, ErrInvalidUpstreamResponse
		}
		return event, nil
	default:
		return nil, ErrInvalidUpstreamResponse
	}
}

// reconcileMessage 按 content_index 重建 message 块。
func (decoder *responseDecoder) reconcileMessage(
	outputIndex uint32,
	item *decodedItem,
	wire outputItemDTO,
) error {
	for index, content := range wire.Content {
		kind, err := messageContentKind(content.Type)
		if err != nil {
			return err
		}
		full := content.Text
		if kind == inference.ContentRefusal {
			full = content.Refusal
		}
		if err := decoder.finalizeMessageBlock(
			outputIndex,
			messageSource(uint32(index)),
			kind,
			full,
			true,
		); err != nil {
			return err
		}
	}
	if len(wire.Content) != len(item.blocks) {
		return ErrInvalidUpstreamResponse
	}
	return decoder.ensureAllBlocksCompleted(item)
}

// verifyCompletedMessageItem 校验重复终态中的 message 内容。
func verifyCompletedMessageItem(
	item *decodedItem,
	wire outputItemDTO,
) error {
	if len(wire.Content) != len(item.blocks) {
		return ErrInvalidUpstreamResponse
	}
	for index, content := range wire.Content {
		kind, err := messageContentKind(content.Type)
		if err != nil {
			return err
		}
		full := content.Text
		if kind == inference.ContentRefusal {
			full = content.Refusal
		}
		if err := verifyCompletedBlock(
			item,
			messageSource(uint32(index)),
			kind,
			full,
		); err != nil {
			return err
		}
	}
	return nil
}

// messageContentKind 映射 Responses message 内容类别。
func messageContentKind(value string) (inference.ContentKind, error) {
	switch value {
	case "output_text":
		return inference.ContentText, nil
	case "refusal":
		return inference.ContentRefusal, nil
	default:
		return "", ErrInvalidUpstreamResponse
	}
}

// messageSource 创建不与 reasoning 源位置冲突的键。
func messageSource(index uint32) string {
	return fmt.Sprintf("message:%d", index)
}
