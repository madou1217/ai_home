package openaichatcompletions

import (
	"strings"

	"github.com/madou1217/ai_home/core/inference"
)

// startContentBlock 要求内容索引连续且与输出项类别匹配。
func (state *responseState) startContentBlock(
	event inference.ContentBlockStartedEvent,
) error {
	item, err := state.openItem(event.OutputIndex())
	if err != nil || int(event.BlockIndex()) != len(item.blocks) {
		return ErrInvalidEventSequence
	}
	if !isChatContentKindAllowed(item.kind, event.ContentKind()) {
		return ErrInvalidEventSequence
	}
	item.blocks = append(item.blocks, &chatContentBlockState{
		kind: event.ContentKind(),
	})
	return nil
}

// isChatContentKindAllowed 校验输出项和内容块类别组合。
func isChatContentKindAllowed(
	itemKind inference.OutputItemKind,
	contentKind inference.ContentKind,
) bool {
	switch itemKind {
	case inference.OutputItemMessage:
		return contentKind == inference.ContentText ||
			contentKind == inference.ContentRefusal
	case inference.OutputItemReasoning:
		return contentKind == inference.ContentReasoning
	default:
		return false
	}
}

// appendBlockText 把文本增量加入指定类别的开放内容块。
func (state *responseState) appendBlockText(
	outputIndex uint32,
	blockIndex uint32,
	kind inference.ContentKind,
	delta string,
) error {
	block, err := state.openBlock(outputIndex, blockIndex, kind)
	if err != nil {
		return err
	}
	block.text += delta
	return nil
}

// completeBlockText 校验累计值是完整文本前缀并保存终值。
func (state *responseState) completeBlockText(
	outputIndex uint32,
	blockIndex uint32,
	kind inference.ContentKind,
	text string,
) error {
	block, err := state.openBlock(outputIndex, blockIndex, kind)
	if err != nil || !strings.HasPrefix(text, block.text) {
		return ErrInvalidEventSequence
	}
	block.text = text
	return nil
}

// appendReasoning 只累计 Chat reasoning_content 可表达的可见文本。
func (state *responseState) appendReasoning(
	event inference.ReasoningDeltaEvent,
) error {
	if event.DeltaKind() != inference.ReasoningDeltaThinking {
		return ErrUnsupportedResponseEvent
	}
	return state.appendBlockText(
		event.OutputIndex(),
		event.BlockIndex(),
		inference.ContentReasoning,
		event.Delta(),
	)
}

// completeReasoning 只接受可见摘要，拒绝签名或加密连续性。
func (state *responseState) completeReasoning(
	event inference.ReasoningCompletedEvent,
) error {
	content := event.Content()
	if content.ReasoningKind() != inference.ReasoningSummary {
		return ErrUnsupportedResponseEvent
	}
	return state.completeBlockText(
		event.OutputIndex(),
		event.BlockIndex(),
		inference.ContentReasoning,
		content.Text(),
	)
}

// completeContentBlock 要求内容块存在、非空且尚未完成。
func (state *responseState) completeContentBlock(
	event inference.ContentBlockCompletedEvent,
) error {
	block, err := state.block(event.OutputIndex(), event.BlockIndex())
	if err != nil || block.completed || block.text == "" {
		return ErrInvalidEventSequence
	}
	block.completed = true
	return nil
}

// block 返回指定位置的内容块。
func (state *responseState) block(
	outputIndex uint32,
	blockIndex uint32,
) (*chatContentBlockState, error) {
	if int(outputIndex) >= len(state.items) {
		return nil, ErrInvalidEventSequence
	}
	item := state.items[outputIndex]
	if int(blockIndex) >= len(item.blocks) {
		return nil, ErrInvalidEventSequence
	}
	return item.blocks[blockIndex], nil
}

// openBlock 返回类别匹配且尚未完成的内容块。
func (state *responseState) openBlock(
	outputIndex uint32,
	blockIndex uint32,
	kind inference.ContentKind,
) (*chatContentBlockState, error) {
	block, err := state.block(outputIndex, blockIndex)
	if err != nil || block.completed || block.kind != kind {
		return nil, ErrInvalidEventSequence
	}
	return block, nil
}

// textSuffix 返回完整文本相对当前累计值缺失的后缀。
func (state *responseState) textSuffix(
	outputIndex uint32,
	blockIndex uint32,
	fullText string,
) (string, error) {
	block, err := state.block(outputIndex, blockIndex)
	if err != nil || !strings.HasPrefix(fullText, block.text) {
		return "", ErrInvalidEventSequence
	}
	return strings.TrimPrefix(fullText, block.text), nil
}
