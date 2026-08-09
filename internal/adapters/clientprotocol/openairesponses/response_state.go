package openairesponses

import (
	"bytes"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/madou1217/ai_home/core/inference"
)

// responseState 是流式和非流式 Renderer 共享的唯一响应状态机。
type responseState struct {
	request         inference.Request
	createdAt       int64
	completedAt     *int64
	completionClock func() time.Time
	started         bool
	terminal        bool
	completed       bool
	responseID      string
	model           string
	lastSequence    uint64
	items           []*outputItemState
	itemIDs         map[string]struct{}
	usage           inference.Usage
	failure         inference.ResponseFailure
	hasFailure      bool
	// stopReason 决定终态渲染成 completed 还是 incomplete，必须留存。
	stopReason inference.StopReason
}

// outputItemState 保存一个 Responses 顶层输出项的完整聚合状态。
type outputItemState struct {
	id               string
	kind             inference.OutputItemKind
	phase            inference.MessagePhase
	completed        bool
	blocks           []*contentBlockState
	callID           string
	toolIdentity     inference.ToolIdentity
	toolArguments    string
	toolCallStarted  bool
	toolCallComplete bool
	webSearchAction  *inference.WebSearchAction
	encryptedContent string
}

// contentBlockState 保存一个消息或 reasoning 内容块的增量与终值。
type contentBlockState struct {
	kind          inference.ContentKind
	completed     bool
	text          string
	signature     string
	reasoningKind inference.ReasoningKind
	citations     []inference.URLCitation
}

// newResponseState 创建共享状态机并固定创建时刻与完成时钟。
func newResponseState(
	request inference.Request,
	createdAt time.Time,
	completionClock func() time.Time,
) *responseState {
	return &responseState{
		request:         request,
		createdAt:       createdAt.Unix(),
		completionClock: completionClock,
		itemIDs:         make(map[string]struct{}),
	}
}

// apply 校验并应用一个 Canonical 事件。
func (state *responseState) apply(event inference.StreamEvent) error {
	if event == nil || state.terminal {
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
		err = state.appendTextDelta(typed.OutputIndex(), typed.BlockIndex(), typed.Delta())
	case inference.TextCompletedEvent:
		err = state.completeText(typed.OutputIndex(), typed.BlockIndex(), typed.Text())
	case inference.RefusalDeltaEvent:
		err = state.appendRefusalDelta(typed.OutputIndex(), typed.BlockIndex(), typed.Delta())
	case inference.RefusalCompletedEvent:
		err = state.completeRefusal(typed.OutputIndex(), typed.BlockIndex(), typed.Refusal())
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
	case inference.WebSearchCompletedEvent:
		err = state.completeWebSearch(typed)
	case inference.URLCitationAddedEvent:
		err = state.addURLCitation(typed)
	case inference.ContentBlockCompletedEvent:
		err = state.completeContentBlock(typed)
	case inference.OutputItemCompletedEvent:
		err = state.completeOutputItem(typed)
	case inference.UsageUpdatedEvent:
		state.usage = typed.Usage()
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

// addURLCitation 把引用绑定到尚未结束的文本块并校验字符区间。
func (state *responseState) addURLCitation(event inference.URLCitationAddedEvent) error {
	block, err := state.openBlock(
		event.OutputIndex(),
		event.BlockIndex(),
		inference.ContentText,
	)
	if err != nil {
		return ErrInvalidEventSequence
	}
	citation := event.Citation()
	if citation.EndIndex() > uint32(utf8.RuneCountInString(block.text)) {
		return ErrInvalidEventSequence
	}
	block.citations = append(block.citations, citation)
	return nil
}

// completeWebSearch 保存服务器侧实际执行的查询。
func (state *responseState) completeWebSearch(
	event inference.WebSearchCompletedEvent,
) error {
	item, err := state.openItem(event.OutputIndex())
	if err != nil || item.kind != inference.OutputItemWebSearch || item.webSearchAction != nil {
		return ErrInvalidEventSequence
	}
	action := event.Action()
	item.webSearchAction = &action
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

// isContentKindAllowed 判断输出项和内容块类别是否形成合法组合。
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

// appendRefusalDelta 将拒绝增量追加到明确的 refusal 块。
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

// completeRefusal 校验拒绝增量前缀并保存完整终值。
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

// appendReasoningDelta 分开累计 thinking 和 signature 数据。
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

// completeReasoning 保存摘要、thinking 或加密连续性终值。
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
		item, itemErr := state.openItem(event.OutputIndex())
		if itemErr != nil {
			return ErrInvalidEventSequence
		}
		block.text = content.Text()
		block.signature = content.Signature()
		block.reasoningKind = inference.ReasoningThinking
		item.encryptedContent = content.Signature()
	case inference.ReasoningEncrypted:
		item, itemErr := state.openItem(event.OutputIndex())
		if itemErr != nil || block.text != "" || block.signature != "" {
			return ErrInvalidEventSequence
		}
		item.encryptedContent = content.EncryptedData()
		block.reasoningKind = inference.ReasoningEncrypted
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
	item.toolIdentity = event.Identity()
	item.toolCallStarted = true
	return nil
}

// appendToolArguments 追加属于明确 call ID 的参数增量。
func (state *responseState) appendToolArguments(event inference.ToolArgumentsDeltaEvent) error {
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
		event.Identity() != item.toolIdentity ||
		!bytes.HasPrefix(event.Arguments(), []byte(item.toolArguments)) {
		return ErrInvalidEventSequence
	}
	item.toolArguments = string(event.Arguments())
	item.toolCallComplete = true
	return nil
}

// completeContentBlock 要求内容块存在且尚未完成。
func (state *responseState) completeContentBlock(event inference.ContentBlockCompletedEvent) error {
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
	} else if item.kind == inference.OutputItemWebSearch {
		if item.webSearchAction == nil || len(item.blocks) != 0 {
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

// completeResponse 只接受所有输出项完成后的明确成功终态。
func (state *responseState) completeResponse(event inference.ResponseCompletedEvent) error {
	for _, item := range state.items {
		if !item.completed {
			return ErrInvalidEventSequence
		}
	}
	state.usage = event.Usage()
	state.stopReason = event.StopReason()
	status, _ := terminalStatusFor(state.stopReason)
	if status == statusCompleted {
		completedAt := state.completionClock().Unix()
		state.completedAt = &completedAt
	}
	state.completed = true
	state.terminal = true
	return nil
}

// openItem 返回存在且尚未完成的输出项。
func (state *responseState) openItem(outputIndex uint32) (*outputItemState, error) {
	if int(outputIndex) >= len(state.items) {
		return nil, ErrInvalidEventSequence
	}
	item := state.items[outputIndex]
	if item.completed {
		return nil, ErrInvalidEventSequence
	}
	return item, nil
}

// item 返回存在的输出项，包括刚刚完成的输出项。
func (state *responseState) item(outputIndex uint32) (*outputItemState, error) {
	if int(outputIndex) >= len(state.items) {
		return nil, ErrInvalidEventSequence
	}
	return state.items[outputIndex], nil
}

// block 返回指定位置的内容块。
func (state *responseState) block(
	outputIndex uint32,
	blockIndex uint32,
) (*contentBlockState, error) {
	if int(outputIndex) >= len(state.items) {
		return nil, ErrInvalidEventSequence
	}
	item := state.items[outputIndex]
	if int(blockIndex) >= len(item.blocks) {
		return nil, ErrInvalidEventSequence
	}
	return item.blocks[blockIndex], nil
}

// openBlock 返回类型匹配且尚未完成的内容块。
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

// openToolCall 返回 call ID 匹配且尚未完成的工具输出项。
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

// toolArgumentsSuffix 返回完整工具参数相对累计增量缺失的后缀。
func (state *responseState) toolArgumentsSuffix(
	outputIndex uint32,
	callID string,
	fullArguments []byte,
) (string, error) {
	item, err := state.openToolCall(outputIndex, callID)
	if err != nil || !bytes.HasPrefix(fullArguments, []byte(item.toolArguments)) {
		return "", ErrInvalidEventSequence
	}
	return strings.TrimPrefix(string(fullArguments), item.toolArguments), nil
}
