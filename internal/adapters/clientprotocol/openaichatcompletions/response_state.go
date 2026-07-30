package openaichatcompletions

import (
	"time"

	"github.com/madou1217/ai_home/core/inference"
)

// responseState 是流式和非流式 Renderer 共享的唯一响应状态机。
type responseState struct {
	// request 保存当前客户端响应意图。
	request inference.Request
	// createdAt 是固定的响应创建 Unix 秒。
	createdAt int64
	// started 表示已经收到 response_started。
	started bool
	// terminal 表示已经收到成功或失败终态。
	terminal bool
	// completed 表示已经收到成功终态。
	completed bool
	// responseID 是 Provider 分配的响应 ID。
	responseID string
	// model 是 Provider 确认使用的真实模型。
	model string
	// lastSequence 是最近成功应用的 Canonical 序号。
	lastSequence uint64
	// items 按 output_index 保存顶层输出项。
	items []*chatOutputItemState
	// itemIDs 用于常数时间拒绝重复输出项 ID。
	itemIDs map[string]struct{}
	// callIDs 用于常数时间拒绝重复工具调用 ID。
	callIDs map[string]struct{}
	// toolCalls 按 Chat choice 内序号保存函数调用。
	toolCalls []*chatToolCallState
	// usage 是最新累计 token 快照。
	usage inference.Usage
	// stopReason 是成功终态的 Canonical 完成原因。
	stopReason inference.StopReason
	// hasFailure 区分失败终态和 Usage 零值。
	hasFailure bool
}

// chatOutputItemState 保存一个 Canonical 顶层输出项的完成状态。
type chatOutputItemState struct {
	// id 是输出项稳定身份。
	id string
	// kind 区分消息、reasoning 和工具调用。
	kind inference.OutputItemKind
	// completed 表示输出项及其子项已经完成。
	completed bool
	// blocks 按 content_index 保存内容块。
	blocks []*chatContentBlockState
	// toolCall 只在工具输出项中存在。
	toolCall *chatToolCallState
}

// chatContentBlockState 保存可见文本、拒绝或 reasoning 的累计值。
type chatContentBlockState struct {
	// kind 区分文本、拒绝和 reasoning。
	kind inference.ContentKind
	// text 是当前累计可见文本。
	text string
	// completed 表示内容块已经关闭。
	completed bool
}

// chatToolCallState 保存一个函数调用及其 Chat choice 内序号。
type chatToolCallState struct {
	// index 是 Chat choice 内连续工具序号。
	index uint32
	// callID 是工具结果必须引用的稳定 ID。
	callID string
	// name 是函数工具名。
	name string
	// arguments 是当前累计 JSON 参数字符串。
	arguments string
	// completed 表示参数终值已经确认。
	completed bool
}

// newResponseState 创建共享状态机并固定响应创建时间。
func newResponseState(request inference.Request, createdAt time.Time) *responseState {
	return &responseState{
		request:   request,
		createdAt: createdAt.Unix(),
		itemIDs:   make(map[string]struct{}),
		callIDs:   make(map[string]struct{}),
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
		err = state.appendBlockText(
			typed.OutputIndex(),
			typed.BlockIndex(),
			inference.ContentText,
			typed.Delta(),
		)
	case inference.TextCompletedEvent:
		err = state.completeBlockText(
			typed.OutputIndex(),
			typed.BlockIndex(),
			inference.ContentText,
			typed.Text(),
		)
	case inference.RefusalDeltaEvent:
		err = state.appendBlockText(
			typed.OutputIndex(),
			typed.BlockIndex(),
			inference.ContentRefusal,
			typed.Delta(),
		)
	case inference.RefusalCompletedEvent:
		err = state.completeBlockText(
			typed.OutputIndex(),
			typed.BlockIndex(),
			inference.ContentRefusal,
			typed.Refusal(),
		)
	case inference.ReasoningDeltaEvent:
		err = state.appendReasoning(typed)
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
		state.usage = typed.Usage()
	case inference.ResponseCompletedEvent:
		err = state.completeResponse(typed)
	case inference.ResponseFailedEvent:
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

// start 初始化响应身份并锁定真实模型。
func (state *responseState) start(event inference.ResponseStartedEvent) error {
	state.started = true
	state.responseID = event.ResponseID()
	state.model = event.Model()
	state.lastSequence = event.Sequence()
	return nil
}

// startOutputItem 要求输出索引连续且 item ID 唯一。
func (state *responseState) startOutputItem(
	event inference.OutputItemStartedEvent,
) error {
	if int(event.OutputIndex()) != len(state.items) {
		return ErrInvalidEventSequence
	}
	if _, exists := state.itemIDs[event.ItemID()]; exists {
		return ErrInvalidEventSequence
	}
	state.itemIDs[event.ItemID()] = struct{}{}
	state.items = append(state.items, &chatOutputItemState{
		id:   event.ItemID(),
		kind: event.ItemKind(),
	})
	return nil
}

// completeOutputItem 要求 ID 匹配且所有嵌套内容已完成。
func (state *responseState) completeOutputItem(
	event inference.OutputItemCompletedEvent,
) error {
	item, err := state.openItem(event.OutputIndex())
	if err != nil || item.id != event.ItemID() {
		return ErrInvalidEventSequence
	}
	if item.kind == inference.OutputItemToolCall {
		if item.toolCall == nil || !item.toolCall.completed {
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
func (state *responseState) completeResponse(
	event inference.ResponseCompletedEvent,
) error {
	for _, item := range state.items {
		if !item.completed {
			return ErrInvalidEventSequence
		}
	}
	state.usage = event.Usage()
	state.stopReason = event.StopReason()
	state.completed = true
	state.terminal = true
	return nil
}

// openItem 返回存在且尚未完成的输出项。
func (state *responseState) openItem(
	outputIndex uint32,
) (*chatOutputItemState, error) {
	if int(outputIndex) >= len(state.items) {
		return nil, ErrInvalidEventSequence
	}
	item := state.items[outputIndex]
	if item.completed {
		return nil, ErrInvalidEventSequence
	}
	return item, nil
}
