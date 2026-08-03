package anthropicmessages

import (
	"bytes"
	"strings"

	"github.com/madou1217/ai_home/core/inference"
)

// responseState 是流式和非流式 Renderer 共享的唯一响应状态机。
type responseState struct {
	request      inference.Request
	started      bool
	terminal     bool
	completed    bool
	responseID   string
	model        string
	lastSequence uint64
	items        []*outputItemState
	itemIDs      map[string]struct{}
	usage        inference.Usage
	stopReason   inference.StopReason
	stopSequence string
	failure      inference.ResponseFailure
	hasFailure   bool
}

// outputItemState 保存一个 Canonical 顶层输出项的聚合状态。
type outputItemState struct {
	id               string
	kind             inference.OutputItemKind
	phase            inference.MessagePhase
	completed        bool
	blocks           []*contentBlockState
	callID           string
	toolName         string
	toolArguments    string
	toolCallStarted  bool
	toolCallComplete bool
}

// contentBlockState 保存一个内容块的增量与终值。
type contentBlockState struct {
	kind          inference.ContentKind
	completed     bool
	text          string
	signature     string
	redactedData  string
	reasoningKind inference.ReasoningKind
}

// reasoningSuffix 是完成事件相对已发送增量的缺失后缀。
type reasoningSuffix struct {
	thinking  string
	signature string
}

// newResponseState 创建严格按事件序号推进的响应状态机。
func newResponseState(request inference.Request) *responseState {
	return &responseState{
		request: request,
		itemIDs: make(map[string]struct{}),
	}
}

// apply 校验并应用一个 Canonical 事件。
func (state *responseState) apply(event inference.StreamEvent) error {
	if event == nil || state.terminal ||
		state.request.ClientProtocol() != inference.ClientProtocolAnthropicMessages {
		return ErrInvalidEventSequence
	}
	if !state.started {
		started, ok := event.(inference.ResponseStartedEvent)
		if !ok || event.Sequence() != 0 {
			return ErrInvalidEventSequence
		}
		return state.start(started)
	}
	if event.Sequence() != state.lastSequence+1 {
		return ErrInvalidEventSequence
	}

	var err error
	switch typed := event.(type) {
	case inference.OutputItemStartedEvent:
		err = state.startOutputItem(typed)
	case inference.ContentBlockStartedEvent:
		err = state.startContentBlock(typed)
	case inference.TextDeltaEvent:
		err = state.appendTextDelta(
			typed.OutputIndex(),
			typed.BlockIndex(),
			typed.Delta(),
		)
	case inference.TextCompletedEvent:
		err = state.completeText(
			typed.OutputIndex(),
			typed.BlockIndex(),
			typed.Text(),
		)
	case inference.RefusalDeltaEvent:
		err = state.appendRefusalDelta(
			typed.OutputIndex(),
			typed.BlockIndex(),
			typed.Delta(),
		)
	case inference.RefusalCompletedEvent:
		err = state.completeRefusal(
			typed.OutputIndex(),
			typed.BlockIndex(),
			typed.Refusal(),
		)
	case inference.ReasoningDeltaEvent:
		err = state.appendReasoningDelta(typed)
	case inference.ReasoningCompletedEvent:
		err = state.completeReasoning(typed)
	case inference.ToolCallStartedEvent:
		err = state.startToolCall(typed)
	case inference.ToolArgumentsDeltaEvent:
		err = state.appendToolArguments(typed)
	case inference.ToolCallCompletedEvent:
		err = state.completeToolCall(typed)
	case inference.ContentBlockCompletedEvent:
		err = state.completeContentBlock(typed)
	case inference.OutputItemCompletedEvent:
		err = state.completeOutputItem(typed)
	case inference.UsageUpdatedEvent:
		err = state.updateUsage(typed.Usage())
	case inference.ResponseCompletedEvent:
		err = state.completeResponse(typed)
	case inference.ResponseFailedEvent:
		state.failure = typed.Failure()
		state.hasFailure = true
		state.terminal = true
	default:
		return ErrUnsupportedResponseEvent
	}
	if err != nil {
		return err
	}
	state.lastSequence = event.Sequence()
	return nil
}

// start 初始化响应身份并锁定模型。
func (state *responseState) start(event inference.ResponseStartedEvent) error {
	state.started = true
	state.responseID = event.ResponseID()
	state.model = event.Model()
	state.lastSequence = event.Sequence()
	return nil
}

// startOutputItem 要求输出索引连续且 item ID 唯一。
func (state *responseState) startOutputItem(event inference.OutputItemStartedEvent) error {
	if int(event.OutputIndex()) != len(state.items) {
		return ErrInvalidEventSequence
	}
	if _, exists := state.itemIDs[event.ItemID()]; exists {
		return ErrInvalidEventSequence
	}
	state.itemIDs[event.ItemID()] = struct{}{}
	state.items = append(state.items, &outputItemState{
		id:    event.ItemID(),
		kind:  event.ItemKind(),
		phase: event.MessagePhase(),
	})
	return nil
}

// startContentBlock 要求内容索引连续且与输出项类别一致。
func (state *responseState) startContentBlock(event inference.ContentBlockStartedEvent) error {
	item, err := state.openItem(event.OutputIndex())
	if err != nil || int(event.BlockIndex()) != len(item.blocks) {
		return ErrInvalidEventSequence
	}
	if !isContentKindAllowed(item.kind, event.ContentKind()) {
		return ErrInvalidEventSequence
	}
	item.blocks = append(item.blocks, &contentBlockState{kind: event.ContentKind()})
	return nil
}

// isContentKindAllowed 判断输出项与内容块类别是否合法。
func isContentKindAllowed(
	itemKind inference.OutputItemKind,
	contentKind inference.ContentKind,
) bool {
	switch itemKind {
	case inference.OutputItemMessage:
		return contentKind == inference.ContentText || contentKind == inference.ContentRefusal
	case inference.OutputItemReasoning:
		return contentKind == inference.ContentReasoning
	default:
		return false
	}
}

// appendTextDelta 将文本增量追加到明确的文本块。
func (state *responseState) appendTextDelta(
	outputIndex uint32,
	blockIndex uint32,
	delta string,
) error {
	block, err := state.openBlock(outputIndex, blockIndex, inference.ContentText)
	if err != nil {
		return err
	}
	block.text += delta
	return nil
}

// completeText 校验增量是完整文本前缀并保存终值。
func (state *responseState) completeText(
	outputIndex uint32,
	blockIndex uint32,
	text string,
) error {
	block, err := state.openBlock(outputIndex, blockIndex, inference.ContentText)
	if err != nil || !strings.HasPrefix(text, block.text) {
		return ErrInvalidEventSequence
	}
	block.text = text
	return nil
}

// appendRefusalDelta 将 refusal 增量追加到独立 Canonical 块。
func (state *responseState) appendRefusalDelta(
	outputIndex uint32,
	blockIndex uint32,
	delta string,
) error {
	block, err := state.openBlock(outputIndex, blockIndex, inference.ContentRefusal)
	if err != nil {
		return err
	}
	block.text += delta
	return nil
}

// completeRefusal 校验 refusal 增量前缀并保存终值。
func (state *responseState) completeRefusal(
	outputIndex uint32,
	blockIndex uint32,
	refusal string,
) error {
	block, err := state.openBlock(outputIndex, blockIndex, inference.ContentRefusal)
	if err != nil || !strings.HasPrefix(refusal, block.text) {
		return ErrInvalidEventSequence
	}
	block.text = refusal
	return nil
}

// appendReasoningDelta 分开累计 thinking 和 signature。
func (state *responseState) appendReasoningDelta(event inference.ReasoningDeltaEvent) error {
	block, err := state.openBlock(
		event.OutputIndex(),
		event.BlockIndex(),
		inference.ContentReasoning,
	)
	if err != nil {
		return err
	}
	switch event.DeltaKind() {
	case inference.ReasoningDeltaThinking:
		block.text += event.Delta()
		block.reasoningKind = inference.ReasoningThinking
	case inference.ReasoningDeltaSignature:
		block.signature += event.Delta()
		block.reasoningKind = inference.ReasoningThinking
	default:
		return ErrUnsupportedResponseEvent
	}
	return nil
}

// completeReasoning 保存 signed thinking 或 redacted thinking 终值。
func (state *responseState) completeReasoning(event inference.ReasoningCompletedEvent) error {
	block, err := state.openBlock(
		event.OutputIndex(),
		event.BlockIndex(),
		inference.ContentReasoning,
	)
	if err != nil {
		return err
	}
	content := event.Content()
	switch content.ReasoningKind() {
	case inference.ReasoningSummary:
		if !strings.HasPrefix(content.Text(), block.text) || block.signature != "" {
			return ErrInvalidEventSequence
		}
		block.text = content.Text()
		block.reasoningKind = inference.ReasoningSummary
	case inference.ReasoningThinking:
		if !strings.HasPrefix(content.Text(), block.text) ||
			!strings.HasPrefix(content.Signature(), block.signature) {
			return ErrInvalidEventSequence
		}
		block.text = content.Text()
		block.signature = content.Signature()
		block.reasoningKind = inference.ReasoningThinking
	case inference.ReasoningRedacted:
		if block.text != "" || block.signature != "" {
			return ErrInvalidEventSequence
		}
		block.redactedData = content.RedactedData()
		block.reasoningKind = inference.ReasoningRedacted
	default:
		return ErrUnsupportedResponseEvent
	}
	return nil
}

// startToolCall 绑定工具输出项、call ID 和工具名。
func (state *responseState) startToolCall(event inference.ToolCallStartedEvent) error {
	item, err := state.openItem(event.OutputIndex())
	if err != nil ||
		item.kind != inference.OutputItemToolCall ||
		item.toolCallStarted ||
		event.BlockIndex() != 0 {
		return ErrInvalidEventSequence
	}
	item.callID = event.CallID()
	item.toolName = event.Name()
	item.toolCallStarted = true
	return nil
}

// appendToolArguments 追加属于明确 call ID 的参数增量。
func (state *responseState) appendToolArguments(
	event inference.ToolArgumentsDeltaEvent,
) error {
	item, err := state.openToolCall(event.OutputIndex(), event.CallID())
	if err != nil || event.BlockIndex() != 0 {
		return ErrInvalidEventSequence
	}
	item.toolArguments += event.Delta()
	return nil
}

// completeToolCall 校验增量是完整 JSON 参数前缀并保存终值。
func (state *responseState) completeToolCall(event inference.ToolCallCompletedEvent) error {
	item, err := state.openToolCall(event.OutputIndex(), event.CallID())
	if err != nil ||
		event.BlockIndex() != 0 ||
		event.Name() != item.toolName ||
		!bytes.HasPrefix(event.Arguments(), []byte(item.toolArguments)) {
		return ErrInvalidEventSequence
	}
	item.toolArguments = string(event.Arguments())
	item.toolCallComplete = true
	return nil
}

// completeContentBlock 要求内容块存在、拥有终值且尚未完成。
func (state *responseState) completeContentBlock(
	event inference.ContentBlockCompletedEvent,
) error {
	block, err := state.block(event.OutputIndex(), event.BlockIndex())
	if err != nil || block.completed {
		return ErrInvalidEventSequence
	}
	switch block.kind {
	case inference.ContentText, inference.ContentRefusal:
		if block.text == "" {
			return ErrInvalidEventSequence
		}
	case inference.ContentReasoning:
		if block.reasoningKind == "" {
			return ErrInvalidEventSequence
		}
	default:
		return ErrInvalidEventSequence
	}
	block.completed = true
	return nil
}

// completeOutputItem 要求 ID 匹配且所有嵌套内容已完成。
func (state *responseState) completeOutputItem(event inference.OutputItemCompletedEvent) error {
	item, err := state.openItem(event.OutputIndex())
	if err != nil || item.id != event.ItemID() {
		return ErrInvalidEventSequence
	}
	if item.kind == inference.OutputItemToolCall {
		if !item.toolCallComplete {
			return ErrInvalidEventSequence
		}
	} else {
		for _, block := range item.blocks {
			if !block.completed {
				return ErrInvalidEventSequence
			}
		}
	}
	item.completed = true
	return nil
}

// updateUsage 要求累计 usage 不能倒退。
func (state *responseState) updateUsage(usage inference.Usage) error {
	if usage.InputTokens() < state.usage.InputTokens() ||
		usage.OutputTokens() < state.usage.OutputTokens() ||
		usage.CachedInputTokens() < state.usage.CachedInputTokens() ||
		usage.CacheWriteInputTokens() < state.usage.CacheWriteInputTokens() ||
		usage.ReasoningTokens() < state.usage.ReasoningTokens() {
		return ErrInvalidEventSequence
	}
	state.usage = usage
	return nil
}

// completeResponse 只接受全部输出项完成后的明确成功终态。
func (state *responseState) completeResponse(event inference.ResponseCompletedEvent) error {
	for _, item := range state.items {
		if !item.completed {
			return ErrInvalidEventSequence
		}
	}
	if err := state.updateUsage(event.Usage()); err != nil {
		return err
	}
	state.stopReason = event.StopReason()
	state.stopSequence = event.StopSequence()
	state.completed = true
	state.terminal = true
	return nil
}

// openItem 返回尚未完成的输出项。
func (state *responseState) openItem(outputIndex uint32) (*outputItemState, error) {
	item, err := state.item(outputIndex)
	if err != nil || item.completed {
		return nil, ErrInvalidEventSequence
	}
	return item, nil
}

// item 返回指定输出项。
func (state *responseState) item(outputIndex uint32) (*outputItemState, error) {
	if int(outputIndex) >= len(state.items) {
		return nil, ErrInvalidEventSequence
	}
	return state.items[outputIndex], nil
}

// openBlock 返回类别匹配且尚未完成的内容块。
func (state *responseState) openBlock(
	outputIndex uint32,
	blockIndex uint32,
	kind inference.ContentKind,
) (*contentBlockState, error) {
	block, err := state.block(outputIndex, blockIndex)
	if err != nil || block.completed || block.kind != kind {
		return nil, ErrInvalidEventSequence
	}
	return block, nil
}

// block 返回指定输出项中的内容块。
func (state *responseState) block(
	outputIndex uint32,
	blockIndex uint32,
) (*contentBlockState, error) {
	item, err := state.item(outputIndex)
	if err != nil || int(blockIndex) >= len(item.blocks) {
		return nil, ErrInvalidEventSequence
	}
	return item.blocks[blockIndex], nil
}

// openToolCall 返回 call ID 匹配且未完成的工具调用。
func (state *responseState) openToolCall(
	outputIndex uint32,
	callID string,
) (*outputItemState, error) {
	item, err := state.openItem(outputIndex)
	if err != nil ||
		item.kind != inference.OutputItemToolCall ||
		!item.toolCallStarted ||
		item.toolCallComplete ||
		item.callID != callID {
		return nil, ErrInvalidEventSequence
	}
	return item, nil
}

// textSuffix 计算文本或 refusal 完成终值尚未通过 delta 发送的部分。
func (state *responseState) textSuffix(
	outputIndex uint32,
	blockIndex uint32,
	complete string,
) (string, error) {
	block, err := state.block(outputIndex, blockIndex)
	if err != nil || !strings.HasPrefix(complete, block.text) {
		return "", ErrInvalidEventSequence
	}
	return strings.TrimPrefix(complete, block.text), nil
}

// reasoningCompletionSuffix 计算 thinking 和 signature 的缺失后缀。
func (state *responseState) reasoningCompletionSuffix(
	event inference.ReasoningCompletedEvent,
) (reasoningSuffix, error) {
	block, err := state.block(event.OutputIndex(), event.BlockIndex())
	if err != nil {
		return reasoningSuffix{}, err
	}
	content := event.Content()
	if content.ReasoningKind() != inference.ReasoningThinking ||
		!strings.HasPrefix(content.Text(), block.text) ||
		!strings.HasPrefix(content.Signature(), block.signature) {
		return reasoningSuffix{}, ErrInvalidEventSequence
	}
	return reasoningSuffix{
		thinking:  strings.TrimPrefix(content.Text(), block.text),
		signature: strings.TrimPrefix(content.Signature(), block.signature),
	}, nil
}

// toolArgumentsSuffix 计算工具参数终值尚未通过 delta 发送的部分。
func (state *responseState) toolArgumentsSuffix(
	outputIndex uint32,
	callID string,
	arguments []byte,
) (string, error) {
	item, err := state.openToolCall(outputIndex, callID)
	if err != nil || !bytes.HasPrefix(arguments, []byte(item.toolArguments)) {
		return "", ErrInvalidEventSequence
	}
	return strings.TrimPrefix(string(arguments), item.toolArguments), nil
}
