package responses

import (
	"encoding/json"

	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/core/inference"
)

// responseDecoder 把一个 Codex Responses 生命周期转换为连续 Canonical 事件。
type responseDecoder struct {
	emit           inferencegateway.EventSink
	effectiveModel string
	responseID     string
	model          string
	nextSequence   uint64
	started        bool
	terminal       bool
	items          []*decodedItem
}

// decodedItem 保存输出项已经向 Canonical 流提交的状态。
type decodedItem struct {
	id              string
	wireType        string
	kind            inference.OutputItemKind
	phase           inference.MessagePhase
	completed       bool
	blocks          []*decodedBlock
	blockBySource   map[string]uint32
	callID          string
	identity        inference.ToolIdentity
	arguments       string
	toolCompleted   bool
	webSearchAction *inference.WebSearchAction
	custom          bool
	customStarted   bool
	customInput     string
	customFinished  bool
}

// decodedBlock 保存一个内容块的累计值和完成状态。
type decodedBlock struct {
	source        string
	kind          inference.ContentKind
	text          string
	valueComplete bool
	completed     bool
}

// newResponseDecoder 创建只依赖事件输出端口的响应状态机。
func newResponseDecoder(
	effectiveModel string,
	emit inferencegateway.EventSink,
) (*responseDecoder, error) {
	if effectiveModel == "" || emit == nil {
		return nil, ErrInvalidDependencies
	}
	return &responseDecoder{
		emit:           emit,
		effectiveModel: effectiveModel,
	}, nil
}

// Apply 校验并应用一个已经完成 SSE 分块重组的 Responses 事件。
func (decoder *responseDecoder) Apply(event streamEventDTO) error {
	if decoder == nil || decoder.terminal || event.Type == "" {
		return ErrInvalidUpstreamResponse
	}
	switch event.Type {
	case "response.created":
		response, err := decodeResponse(event.Response)
		if err != nil {
			return err
		}
		return decoder.startResponse(response)
	case "response.in_progress", "response.queued", "response.metadata":
		return nil
	case "response.output_item.added":
		item, err := decodeOutputItem(event.Item)
		if err != nil || event.OutputIndex == nil {
			return ErrInvalidUpstreamResponse
		}
		decoded, err := decoder.startItem(
			*event.OutputIndex,
			item,
			false,
		)
		if err != nil {
			return err
		}
		return decoder.applyAddedItemSnapshot(
			*event.OutputIndex,
			decoded,
			item,
		)
	case "response.content_part.added":
		return decoder.addContentPart(event)
	case "response.output_text.delta":
		return decoder.appendMessageDelta(event, inference.ContentText)
	case "response.output_text.done":
		return decoder.completeMessageValue(event, inference.ContentText)
	case "response.refusal.delta":
		return decoder.appendMessageDelta(event, inference.ContentRefusal)
	case "response.refusal.done":
		return decoder.completeMessageValue(event, inference.ContentRefusal)
	case "response.content_part.done":
		return decoder.completeContentPart(event)
	case "response.reasoning_summary_part.added":
		return decoder.addReasoningPart(event)
	case "response.reasoning_summary_text.delta":
		return decoder.appendReasoningDelta(event, "summary")
	case "response.reasoning_summary_text.done":
		return decoder.completeReasoningValue(event, "summary")
	case "response.reasoning_summary_part.done":
		return decoder.completeReasoningPart(event)
	case "response.reasoning_text.delta":
		return decoder.appendReasoningDelta(event, "content")
	case "response.reasoning_text.done":
		return decoder.completeReasoningValue(event, "content")
	case "response.function_call_arguments.delta":
		return decoder.appendFunctionArguments(event)
	case "response.function_call_arguments.done":
		return decoder.completeFunctionArguments(event)
	case "response.custom_tool_call_input.delta":
		return decoder.appendCustomInput(event)
	case "response.custom_tool_call_input.done":
		return decoder.completeCustomInput(event)
	case "response.output_item.done":
		return decoder.completeOutputItem(event)
	case "response.completed":
		response, err := decodeResponse(event.Response)
		if err != nil {
			return err
		}
		return decoder.completeResponse(
			response,
			decoder.completedStopReason(response),
		)
	case "response.incomplete":
		response, err := decodeResponse(event.Response)
		if err != nil {
			return err
		}
		stopReason, err := incompleteStopReason(response)
		if err != nil {
			return err
		}
		return decoder.completeResponse(response, stopReason)
	default:
		return ErrInvalidUpstreamResponse
	}
}

// Terminal 表示 Decoder 已收到明确成功或可表达的 incomplete 终态。
func (decoder *responseDecoder) Terminal() bool {
	return decoder != nil && decoder.terminal
}

// startResponse 固定响应身份；重复 created 事件会被拒绝。
func (decoder *responseDecoder) startResponse(response responseDTO) error {
	if decoder.started || response.ID == "" {
		return ErrInvalidUpstreamResponse
	}
	model := response.Model
	if model == "" {
		model = decoder.effectiveModel
	}
	event, err := inference.NewResponseStartedEvent(
		decoder.nextSequence,
		response.ID,
		model,
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.emitEvent(event); err != nil {
		return err
	}
	decoder.responseID = response.ID
	decoder.model = model
	decoder.started = true
	return nil
}

// ensureResponseIdentity 校验终态快照没有改变 created 的身份。
func (decoder *responseDecoder) ensureResponseIdentity(
	response responseDTO,
) error {
	if !decoder.started {
		return decoder.startResponse(response)
	}
	if response.ID != "" && response.ID != decoder.responseID {
		return ErrInvalidUpstreamResponse
	}
	if response.Model != "" && response.Model != decoder.model {
		return ErrInvalidUpstreamResponse
	}
	return nil
}

// completeResponse 补齐 output 快照、usage 和唯一终态。
func (decoder *responseDecoder) completeResponse(
	response responseDTO,
	stopReason inference.StopReason,
) error {
	if err := decoder.ensureResponseIdentity(response); err != nil {
		return err
	}
	for index, wire := range response.Output {
		if err := decoder.reconcileItem(uint32(index), wire); err != nil {
			return err
		}
	}
	if len(response.Output) > 0 &&
		len(response.Output) != len(decoder.items) {
		return ErrInvalidUpstreamResponse
	}
	for _, item := range decoder.items {
		if !item.completed {
			return ErrInvalidUpstreamResponse
		}
	}
	usage, err := decodeUsage(response.Usage)
	if err != nil {
		return err
	}
	if response.Usage != nil {
		usageEvent, constructErr := inference.NewUsageUpdatedEvent(
			decoder.nextSequence,
			usage,
		)
		if constructErr != nil {
			return ErrInvalidUpstreamResponse
		}
		if err := decoder.emitEvent(usageEvent); err != nil {
			return err
		}
	}
	completed, err := inference.NewResponseCompletedEvent(
		decoder.nextSequence,
		stopReason,
		"",
		usage,
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.emitEvent(completed); err != nil {
		return err
	}
	decoder.terminal = true
	return nil
}

// completedStopReason 使用 end_turn 和工具输出推断规范结束原因。
func (decoder *responseDecoder) completedStopReason(
	response responseDTO,
) inference.StopReason {
	if response.EndTurn != nil && *response.EndTurn {
		return inference.StopReasonEndTurn
	}
	for _, item := range decoder.items {
		if item.kind == inference.OutputItemToolCall {
			return inference.StopReasonToolUse
		}
	}
	if response.EndTurn != nil && !*response.EndTurn {
		return inference.StopReasonPauseTurn
	}
	return inference.StopReasonEndTurn
}

// incompleteStopReason 只把可无歧义表达的 incomplete 原因变成成功终态。
func incompleteStopReason(
	response responseDTO,
) (inference.StopReason, error) {
	if response.IncompleteDetails == nil {
		return "", ErrInvalidUpstreamResponse
	}
	switch response.IncompleteDetails.Reason {
	case "max_output_tokens":
		return inference.StopReasonMaxTokens, nil
	case "content_filter":
		return inference.StopReasonContentFilter, nil
	case "cancelled":
		return inference.StopReasonCancelled, nil
	default:
		return "", ErrInvalidUpstreamResponse
	}
}

// decodeUsage 校验 token 子集和上游 total_tokens 一致。
func decodeUsage(wire *usageDTO) (inference.Usage, error) {
	input := inference.UsageInput{}
	if wire != nil {
		input.InputTokens = wire.InputTokens
		input.OutputTokens = wire.OutputTokens
		if wire.InputTokenDetails != nil {
			input.CachedInputTokens = wire.InputTokenDetails.CachedTokens
		}
		if wire.OutputTokenDetails != nil {
			input.ReasoningTokens = wire.OutputTokenDetails.ReasoningTokens
		}
	}
	usage, err := inference.NewUsage(input)
	if err != nil {
		return inference.Usage{}, ErrInvalidUpstreamResponse
	}
	if wire != nil &&
		wire.TotalTokens != nil &&
		*wire.TotalTokens != usage.TotalTokens() {
		return inference.Usage{}, ErrInvalidUpstreamResponse
	}
	return usage, nil
}

// emitEvent 同步传播背压，成功后才推进序号。
func (decoder *responseDecoder) emitEvent(
	event inference.StreamEvent,
) error {
	if event == nil || event.Sequence() != decoder.nextSequence {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.emit(event); err != nil {
		return eventSinkError{cause: err}
	}
	decoder.nextSequence++
	return nil
}

// item 返回已经开始且未越界的输出项。
func (decoder *responseDecoder) item(
	outputIndex uint32,
) (*decodedItem, error) {
	if int(outputIndex) >= len(decoder.items) {
		return nil, ErrInvalidUpstreamResponse
	}
	return decoder.items[outputIndex], nil
}

// validateItemReference 校验事件中的可选 item_id 属于 output_index。
func (decoder *responseDecoder) validateItemReference(
	event streamEventDTO,
) error {
	if event.OutputIndex == nil {
		return ErrInvalidUpstreamResponse
	}
	item, err := decoder.item(*event.OutputIndex)
	if err != nil ||
		event.ItemID != "" && event.ItemID != item.id {
		return ErrInvalidUpstreamResponse
	}
	return nil
}

// decodeResponse 解码终态或 created 中的响应快照。
func decodeResponse(raw json.RawMessage) (responseDTO, error) {
	var response responseDTO
	if len(raw) == 0 || json.Unmarshal(raw, &response) != nil {
		return responseDTO{}, ErrInvalidUpstreamResponse
	}
	return response, nil
}
