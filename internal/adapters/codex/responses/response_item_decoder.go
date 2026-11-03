package responses

import (
	"encoding/json"

	"github.com/madou1217/ai_home/core/inference"
)

// startItem 创建连续输出项，并立即绑定工具调用身份。
func (decoder *responseDecoder) startItem(
	outputIndex uint32,
	wire outputItemDTO,
	allowExisting bool,
) (*decodedItem, error) {
	if int(outputIndex) < len(decoder.items) {
		item := decoder.items[outputIndex]
		if !allowExisting ||
			item.id != wire.ID ||
			item.wireType != wire.Type {
			return nil, ErrInvalidUpstreamResponse
		}
		return item, nil
	}
	if !decoder.started ||
		int(outputIndex) != len(decoder.items) ||
		wire.ID == "" {
		return nil, ErrInvalidUpstreamResponse
	}
	item, err := newDecodedItem(wire)
	if err != nil {
		return nil, err
	}
	started, err := newOutputItemStartedEvent(
		decoder.nextSequence,
		outputIndex,
		item,
	)
	if err != nil {
		return nil, err
	}
	if err := decoder.emitEvent(started); err != nil {
		return nil, err
	}
	decoder.items = append(decoder.items, item)
	if item.kind == inference.OutputItemToolCall {
		toolStarted, toolErr := newCanonicalToolCallStartedEvent(
			decoder.nextSequence,
			outputIndex,
			item.callID,
			item.identity,
		)
		if toolErr != nil {
			return nil, ErrInvalidUpstreamResponse
		}
		if err := decoder.emitEvent(toolStarted); err != nil {
			return nil, err
		}
	}
	return item, nil
}

// applyAddedItemSnapshot 保留 added 事件中已经存在的非空增量。
func (decoder *responseDecoder) applyAddedItemSnapshot(
	outputIndex uint32,
	item *decodedItem,
	wire outputItemDTO,
) error {
	switch item.kind {
	case inference.OutputItemMessage:
		return decoder.applyAddedMessageSnapshot(
			outputIndex,
			item,
			wire,
		)
	case inference.OutputItemReasoning:
		return decoder.applyAddedReasoningSnapshot(
			outputIndex,
			item,
			wire,
		)
	case inference.OutputItemToolCall:
		if item.custom {
			if wire.Input == "" {
				return nil
			}
			return decoder.appendCustomInput(streamEventDTO{
				OutputIndex: &outputIndex,
				ItemID:      item.id,
				CallID:      item.callID,
				Delta:       wire.Input,
			})
		}
		return decoder.appendToolArguments(
			outputIndex,
			item,
			wire.Arguments,
		)
	case inference.OutputItemWebSearch:
		if wire.Action == nil {
			return nil
		}
		return decoder.completeWebSearchAction(outputIndex, item, *wire.Action)
	default:
		return ErrInvalidUpstreamResponse
	}
}

// newDecodedItem 把上游输出项类别收敛为 Canonical 类别。
func newDecodedItem(wire outputItemDTO) (*decodedItem, error) {
	item := &decodedItem{
		id:            wire.ID,
		wireType:      wire.Type,
		blockBySource: make(map[string]uint32),
	}
	switch wire.Type {
	case "message":
		if wire.Role != "" && wire.Role != string(inference.RoleAssistant) {
			return nil, ErrInvalidUpstreamResponse
		}
		item.kind = inference.OutputItemMessage
		if wire.Phase != "" {
			item.phase = inference.MessagePhase(wire.Phase)
			if !item.phase.IsValid() {
				return nil, ErrInvalidUpstreamResponse
			}
		}
	case "reasoning":
		item.kind = inference.OutputItemReasoning
	case "function_call", "custom_tool_call":
		if wire.CallID == "" || wire.Name == "" {
			return nil, ErrInvalidUpstreamResponse
		}
		item.kind = inference.OutputItemToolCall
		item.callID = wire.CallID
		identity, err := newResponseToolIdentity(wire.Namespace, wire.Name)
		if err != nil {
			return nil, err
		}
		item.identity = identity
		item.custom = wire.Type == "custom_tool_call"
	case "web_search_call":
		if wire.Status != "in_progress" && wire.Status != "searching" &&
			wire.Status != "completed" {
			return nil, ErrInvalidUpstreamResponse
		}
		item.kind = inference.OutputItemWebSearch
	default:
		return nil, ErrInvalidUpstreamResponse
	}
	return item, nil
}

// newOutputItemStartedEvent 保留 Codex assistant phase。
func newOutputItemStartedEvent(
	sequence uint64,
	outputIndex uint32,
	item *decodedItem,
) (inference.OutputItemStartedEvent, error) {
	if item.phase != "" {
		event, err := inference.NewPhasedOutputItemStartedEvent(
			sequence,
			outputIndex,
			item.id,
			item.phase,
		)
		if err != nil {
			return inference.OutputItemStartedEvent{},
				ErrInvalidUpstreamResponse
		}
		return event, nil
	}
	event, err := inference.NewOutputItemStartedEvent(
		sequence,
		outputIndex,
		item.id,
		item.kind,
	)
	if err != nil {
		return inference.OutputItemStartedEvent{},
			ErrInvalidUpstreamResponse
	}
	return event, nil
}

// completeOutputItem 用 done 快照补齐缺失的增量和完成事件。
func (decoder *responseDecoder) completeOutputItem(
	event streamEventDTO,
) error {
	if event.OutputIndex == nil {
		return ErrInvalidUpstreamResponse
	}
	wire, err := decodeOutputItem(event.Item)
	if err != nil {
		return err
	}
	if event.ItemID != "" && event.ItemID != wire.ID {
		return ErrInvalidUpstreamResponse
	}
	return decoder.reconcileItem(*event.OutputIndex, wire)
}

// reconcileItem 让完整快照成为单个输出项的最终真值。
func (decoder *responseDecoder) reconcileItem(
	outputIndex uint32,
	wire outputItemDTO,
) error {
	item, err := decoder.startItem(outputIndex, wire, true)
	if err != nil {
		return err
	}
	if item.completed {
		return decoder.verifyCompletedItem(item, wire)
	}
	switch item.kind {
	case inference.OutputItemMessage:
		err = decoder.reconcileMessage(outputIndex, item, wire)
	case inference.OutputItemReasoning:
		err = decoder.reconcileReasoning(outputIndex, item, wire)
	case inference.OutputItemToolCall:
		if item.custom {
			err = decoder.finalizeCustomInput(outputIndex, item, wire.Input)
		} else {
			err = decoder.finalizeToolArguments(outputIndex, item, wire.Arguments)
		}
	case inference.OutputItemWebSearch:
		if wire.Status != "completed" || wire.Action == nil {
			err = ErrInvalidUpstreamResponse
		} else {
			err = decoder.completeWebSearchAction(outputIndex, item, *wire.Action)
		}
	default:
		err = ErrInvalidUpstreamResponse
	}
	if err != nil {
		return err
	}
	return decoder.finishItem(outputIndex, item)
}

// ensureAllBlocksCompleted 拒绝 done 快照遗漏已经开始但未完成的块。
func (decoder *responseDecoder) ensureAllBlocksCompleted(
	item *decodedItem,
) error {
	for _, block := range item.blocks {
		if !block.completed {
			return ErrInvalidUpstreamResponse
		}
	}
	return nil
}

// finishItem 在所有嵌套值完成后提交输出项完成事件。
func (decoder *responseDecoder) finishItem(
	outputIndex uint32,
	item *decodedItem,
) error {
	if item.completed {
		return nil
	}
	if item.kind == inference.OutputItemToolCall {
		if !item.toolCompleted {
			return ErrInvalidUpstreamResponse
		}
	} else if item.kind == inference.OutputItemWebSearch {
		if item.webSearchAction == nil {
			return ErrInvalidUpstreamResponse
		}
	} else if err := decoder.ensureAllBlocksCompleted(item); err != nil {
		return err
	}
	event, err := inference.NewOutputItemCompletedEvent(
		decoder.nextSequence,
		outputIndex,
		item.id,
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.emitEvent(event); err != nil {
		return err
	}
	item.completed = true
	return nil
}

// verifyCompletedItem 拒绝终态响应中的矛盾输出项身份或工具参数。
func (decoder *responseDecoder) verifyCompletedItem(
	item *decodedItem,
	wire outputItemDTO,
) error {
	if item.id != wire.ID || item.wireType != wire.Type {
		return ErrInvalidUpstreamResponse
	}
	switch item.kind {
	case inference.OutputItemToolCall:
		return verifyCompletedToolItem(item, wire)
	case inference.OutputItemMessage:
		return verifyCompletedMessageItem(item, wire)
	case inference.OutputItemReasoning:
		return verifyCompletedReasoningItem(item, wire)
	case inference.OutputItemWebSearch:
		if wire.Status != "completed" || wire.Action == nil {
			return ErrInvalidUpstreamResponse
		}
		action, err := decodeWebSearchAction(*wire.Action)
		if err != nil || item.webSearchAction == nil || !item.webSearchAction.Equal(action) {
			return ErrInvalidUpstreamResponse
		}
		return nil
	default:
		return ErrInvalidUpstreamResponse
	}
}

// verifyCompletedToolItem 校验工具身份和最终参数。
func verifyCompletedToolItem(
	item *decodedItem,
	wire outputItemDTO,
) error {
	identity, err := newResponseToolIdentity(wire.Namespace, wire.Name)
	if err != nil || item.callID != wire.CallID || item.identity != identity {
		return ErrInvalidUpstreamResponse
	}
	expected := wire.Arguments
	if item.custom {
		value, err := marshalCustomArguments(wire.Input)
		if err != nil {
			return err
		}
		expected = value
	}
	if item.arguments != expected {
		return ErrInvalidUpstreamResponse
	}
	return nil
}

// completeWebSearchAction 提交一次完整搜索动作并保证重复快照一致。
func (decoder *responseDecoder) completeWebSearchAction(
	outputIndex uint32,
	item *decodedItem,
	wire webSearchActionDTO,
) error {
	action, err := decodeWebSearchAction(wire)
	if err != nil {
		return err
	}
	if item.webSearchAction != nil {
		if !item.webSearchAction.Equal(action) {
			return ErrInvalidUpstreamResponse
		}
		return nil
	}
	event, err := inference.NewWebSearchActionCompletedEvent(
		decoder.nextSequence,
		outputIndex,
		action,
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.emitEvent(event); err != nil {
		return err
	}
	item.webSearchAction = &action
	return nil
}

// decodeWebSearchAction 解码 Responses 公开的 search/open/find 联合类型。
func decodeWebSearchAction(wire webSearchActionDTO) (inference.WebSearchAction, error) {
	var (
		action inference.WebSearchAction
		err    error
	)
	switch wire.Type {
	case "search":
		sources := make([]string, len(wire.Sources))
		for index, source := range wire.Sources {
			if source.Type != "url" {
				return inference.WebSearchAction{}, ErrInvalidUpstreamResponse
			}
			sources[index] = source.URL
		}
		action, err = inference.NewWebSearchAction(wire.Query, wire.Queries, sources)
	case "open_page":
		action, err = inference.NewWebOpenPageAction(wire.URL)
	case "find_in_page":
		action, err = inference.NewWebFindInPageAction(wire.URL, wire.Pattern)
	default:
		err = ErrInvalidUpstreamResponse
	}
	if err != nil {
		return inference.WebSearchAction{}, ErrInvalidUpstreamResponse
	}
	return action, nil
}

// newResponseToolIdentity 从 Responses 可选 namespace 恢复完整工具身份。
func newResponseToolIdentity(namespace string, name string) (inference.ToolIdentity, error) {
	var (
		identity inference.ToolIdentity
		err      error
	)
	if namespace == "" {
		identity, err = inference.NewToolIdentity(name)
	} else {
		identity, err = inference.NewNamespacedToolIdentity(namespace, name)
	}
	if err != nil {
		return inference.ToolIdentity{}, ErrInvalidUpstreamResponse
	}
	return identity, nil
}

// newCanonicalToolCallStartedEvent 用完整身份选择普通或 namespaced 构造器。
func newCanonicalToolCallStartedEvent(
	sequence uint64,
	outputIndex uint32,
	callID string,
	identity inference.ToolIdentity,
) (inference.ToolCallStartedEvent, error) {
	if namespace, found := identity.Namespace(); found {
		return inference.NewNamespacedToolCallStartedEvent(
			sequence,
			outputIndex,
			0,
			callID,
			namespace,
			identity.Name(),
		)
	}
	return inference.NewToolCallStartedEvent(
		sequence,
		outputIndex,
		0,
		callID,
		identity.Name(),
	)
}

// verifyCompletedBlock 校验终态快照中的已知块没有改变。
func verifyCompletedBlock(
	item *decodedItem,
	source string,
	kind inference.ContentKind,
	full string,
) error {
	blockIndex, found := item.blockBySource[source]
	if !found {
		return ErrInvalidUpstreamResponse
	}
	block := item.blocks[blockIndex]
	if block.kind != kind ||
		block.text != full ||
		!block.valueComplete ||
		!block.completed {
		return ErrInvalidUpstreamResponse
	}
	return nil
}

// ensureBlock 按 Provider 源位置只创建一次连续 Canonical 块。
func (decoder *responseDecoder) ensureBlock(
	outputIndex uint32,
	source string,
	kind inference.ContentKind,
) (*decodedBlock, uint32, error) {
	item, err := decoder.item(outputIndex)
	if err != nil ||
		item.completed ||
		(item.kind == inference.OutputItemMessage &&
			kind != inference.ContentText &&
			kind != inference.ContentRefusal) ||
		(item.kind == inference.OutputItemReasoning &&
			kind != inference.ContentReasoning) ||
		item.kind == inference.OutputItemToolCall {
		return nil, 0, ErrInvalidUpstreamResponse
	}
	if blockIndex, found := item.blockBySource[source]; found {
		block := item.blocks[blockIndex]
		if block.kind != kind {
			return nil, 0, ErrInvalidUpstreamResponse
		}
		return block, blockIndex, nil
	}
	blockIndex := uint32(len(item.blocks))
	event, err := inference.NewContentBlockStartedEvent(
		decoder.nextSequence,
		outputIndex,
		blockIndex,
		kind,
	)
	if err != nil {
		return nil, 0, ErrInvalidUpstreamResponse
	}
	if err := decoder.emitEvent(event); err != nil {
		return nil, 0, err
	}
	block := &decodedBlock{source: source, kind: kind}
	item.blocks = append(item.blocks, block)
	item.blockBySource[source] = blockIndex
	return block, blockIndex, nil
}

// finishBlock 只提交一次内容块完成事件。
func (decoder *responseDecoder) finishBlock(
	outputIndex uint32,
	blockIndex uint32,
	block *decodedBlock,
) error {
	if block.completed {
		return nil
	}
	if !block.valueComplete {
		return ErrInvalidUpstreamResponse
	}
	event := inference.NewContentBlockCompletedEvent(
		decoder.nextSequence,
		outputIndex,
		blockIndex,
	)
	if err := decoder.emitEvent(event); err != nil {
		return err
	}
	block.completed = true
	return nil
}

// decodeOutputItem 解码 added/done 输出项。
func decodeOutputItem(raw json.RawMessage) (outputItemDTO, error) {
	var item outputItemDTO
	if len(raw) == 0 || json.Unmarshal(raw, &item) != nil {
		return outputItemDTO{}, ErrInvalidUpstreamResponse
	}
	return item, nil
}

// decodeOutputContent 解码 message 内容 part。
func decodeOutputContent(
	raw json.RawMessage,
) (outputContentDTO, error) {
	var content outputContentDTO
	if len(raw) == 0 || json.Unmarshal(raw, &content) != nil {
		return outputContentDTO{}, ErrInvalidUpstreamResponse
	}
	return content, nil
}
