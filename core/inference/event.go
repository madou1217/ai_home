package inference

// EventKind 是 Canonical Event Stream 中的稳定事件类别。
type EventKind string

const (
	// EventResponseStarted 表示上游已经创建响应。
	EventResponseStarted EventKind = "response_started"
	// EventOutputItemStarted 表示拥有稳定 item ID 的输出项开始。
	EventOutputItemStarted EventKind = "output_item_started"
	// EventOutputItemCompleted 表示拥有稳定 item ID 的输出项完成。
	EventOutputItemCompleted EventKind = "output_item_completed"
	// EventContentBlockStarted 表示一个有明确索引和类别的内容块开始。
	EventContentBlockStarted EventKind = "content_block_started"
	// EventTextDelta 表示普通文本增量。
	EventTextDelta EventKind = "text_delta"
	// EventTextCompleted 表示指定内容块的完整文本终值。
	EventTextCompleted EventKind = "text_completed"
	// EventRefusalDelta 表示模型安全或策略拒绝增量。
	EventRefusalDelta EventKind = "refusal_delta"
	// EventRefusalCompleted 表示模型安全或策略拒绝终值。
	EventRefusalCompleted EventKind = "refusal_completed"
	// EventReasoningDelta 表示 thinking 或 signature 增量。
	EventReasoningDelta EventKind = "reasoning_delta"
	// EventReasoningCompleted 表示完整 reasoning 摘要、thinking 或加密连续性。
	EventReasoningCompleted EventKind = "reasoning_completed"
	// EventToolCallStarted 表示一个有明确 call ID 的工具调用开始。
	EventToolCallStarted EventKind = "tool_call_started"
	// EventToolArgumentsDelta 表示工具参数 JSON 的原始增量。
	EventToolArgumentsDelta EventKind = "tool_arguments_delta"
	// EventToolCallCompleted 表示工具调用拥有完整且合法的参数。
	EventToolCallCompleted EventKind = "tool_call_completed"
	// EventContentBlockCompleted 表示指定内容块已经完整结束。
	EventContentBlockCompleted EventKind = "content_block_completed"
	// EventUsageUpdated 表示累计 token 快照更新。
	EventUsageUpdated EventKind = "usage_updated"
	// EventResponseCompleted 表示响应收到明确完成事件。
	EventResponseCompleted EventKind = "response_completed"
	// EventResponseFailed 表示响应明确失败或在完成事件前断流。
	EventResponseFailed EventKind = "response_failed"
)

// StreamEvent 是 Provider Decoder 向 Renderer 输出的封闭事件联合类型。
type StreamEvent interface {
	// Kind 返回与 Provider 事件名解耦的稳定类别。
	Kind() EventKind
	// Sequence 返回 Decoder 分配的单调事件序号。
	Sequence() uint64
	isStreamEvent()
}

// eventBase 保存所有 Canonical 流事件共有的序号。
type eventBase struct {
	sequence uint64
}

// Sequence 返回 Decoder 分配的单调事件序号。
func (event eventBase) Sequence() uint64 {
	return event.sequence
}

// eventPosition 保存一个输出项内内容块的稳定位置。
type eventPosition struct {
	outputIndex uint32
	blockIndex  uint32
}

// ResponseStartedEvent 是响应生命周期的第一个 Canonical 事件。
type ResponseStartedEvent struct {
	eventBase
	responseID string
	model      string
}

// NewResponseStartedEvent 创建拥有明确响应 ID 和模型的开始事件。
func NewResponseStartedEvent(
	sequence uint64,
	responseID string,
	model string,
) (ResponseStartedEvent, error) {
	if !isCanonicalOpaqueID(responseID) || !isCanonicalModelID(model) {
		return ResponseStartedEvent{}, ErrInvalidEvent
	}
	return ResponseStartedEvent{
		eventBase:  eventBase{sequence: sequence},
		responseID: responseID,
		model:      model,
	}, nil
}

// Kind 返回响应开始类别。
func (ResponseStartedEvent) Kind() EventKind {
	return EventResponseStarted
}

// ResponseID 返回 Provider 响应的稳定标识。
func (event ResponseStartedEvent) ResponseID() string {
	return event.responseID
}

// Model 返回上游确认使用的真实模型。
func (event ResponseStartedEvent) Model() string {
	return event.model
}

// isStreamEvent 将 ResponseStartedEvent 限制在 Canonical 事件联合类型内。
func (ResponseStartedEvent) isStreamEvent() {}

// OutputItemKind 是响应顶层输出项的稳定类别。
type OutputItemKind string

const (
	// OutputItemMessage 表示 Assistant 消息输出项。
	OutputItemMessage OutputItemKind = "message"
	// OutputItemReasoning 表示 reasoning 输出项。
	OutputItemReasoning OutputItemKind = "reasoning"
	// OutputItemToolCall 表示函数工具调用输出项。
	OutputItemToolCall OutputItemKind = "tool_call"
)

// IsValid 判断输出项类别是否已经注册。
func (kind OutputItemKind) IsValid() bool {
	return kind == OutputItemMessage || kind == OutputItemReasoning || kind == OutputItemToolCall
}

// OutputItemStartedEvent 表示顶层输出项拥有明确身份并开始生成。
type OutputItemStartedEvent struct {
	eventBase
	outputIndex  uint32
	itemID       string
	itemKind     OutputItemKind
	messagePhase MessagePhase
}

// NewOutputItemStartedEvent 创建输出项开始事件。
func NewOutputItemStartedEvent(
	sequence uint64,
	outputIndex uint32,
	itemID string,
	itemKind OutputItemKind,
) (OutputItemStartedEvent, error) {
	if !isCanonicalOpaqueID(itemID) || !itemKind.IsValid() {
		return OutputItemStartedEvent{}, ErrInvalidEvent
	}
	return OutputItemStartedEvent{
		eventBase:   eventBase{sequence: sequence},
		outputIndex: outputIndex,
		itemID:      itemID,
		itemKind:    itemKind,
	}, nil
}

// NewPhasedOutputItemStartedEvent 创建保留 Codex assistant phase 的消息输出项。
func NewPhasedOutputItemStartedEvent(
	sequence uint64,
	outputIndex uint32,
	itemID string,
	phase MessagePhase,
) (OutputItemStartedEvent, error) {
	if !phase.IsValid() {
		return OutputItemStartedEvent{}, ErrInvalidEvent
	}
	event, err := NewOutputItemStartedEvent(sequence, outputIndex, itemID, OutputItemMessage)
	if err != nil {
		return OutputItemStartedEvent{}, err
	}
	event.messagePhase = phase
	return event, nil
}

// Kind 返回输出项开始类别。
func (OutputItemStartedEvent) Kind() EventKind {
	return EventOutputItemStarted
}

// OutputIndex 返回响应顶层输出索引。
func (event OutputItemStartedEvent) OutputIndex() uint32 {
	return event.outputIndex
}

// ItemID 返回 Provider 提供的稳定输出项 ID。
func (event OutputItemStartedEvent) ItemID() string {
	return event.itemID
}

// ItemKind 返回输出项的稳定类别。
func (event OutputItemStartedEvent) ItemKind() OutputItemKind {
	return event.itemKind
}

// MessagePhase 返回消息输出项的可选 commentary 或 final_answer 阶段。
func (event OutputItemStartedEvent) MessagePhase() MessagePhase {
	return event.messagePhase
}

// isStreamEvent 将 OutputItemStartedEvent 限制在 Canonical 事件联合类型内。
func (OutputItemStartedEvent) isStreamEvent() {}

// OutputItemCompletedEvent 表示指定顶层输出项明确完成。
type OutputItemCompletedEvent struct {
	eventBase
	outputIndex uint32
	itemID      string
}

// NewOutputItemCompletedEvent 创建输出项完成事件。
func NewOutputItemCompletedEvent(
	sequence uint64,
	outputIndex uint32,
	itemID string,
) (OutputItemCompletedEvent, error) {
	if !isCanonicalOpaqueID(itemID) {
		return OutputItemCompletedEvent{}, ErrInvalidEvent
	}
	return OutputItemCompletedEvent{
		eventBase:   eventBase{sequence: sequence},
		outputIndex: outputIndex,
		itemID:      itemID,
	}, nil
}

// Kind 返回输出项完成类别。
func (OutputItemCompletedEvent) Kind() EventKind {
	return EventOutputItemCompleted
}

// OutputIndex 返回响应顶层输出索引。
func (event OutputItemCompletedEvent) OutputIndex() uint32 {
	return event.outputIndex
}

// ItemID 返回 Provider 提供的稳定输出项 ID。
func (event OutputItemCompletedEvent) ItemID() string {
	return event.itemID
}

// isStreamEvent 将 OutputItemCompletedEvent 限制在 Canonical 事件联合类型内。
func (OutputItemCompletedEvent) isStreamEvent() {}

// ContentBlockStartedEvent 表示一个有明确位置和内容类别的块开始。
type ContentBlockStartedEvent struct {
	eventBase
	eventPosition
	contentKind ContentKind
}

// NewContentBlockStartedEvent 创建内容块开始事件。
func NewContentBlockStartedEvent(
	sequence uint64,
	outputIndex uint32,
	blockIndex uint32,
	contentKind ContentKind,
) (ContentBlockStartedEvent, error) {
	if !contentKind.IsValid() {
		return ContentBlockStartedEvent{}, ErrInvalidEvent
	}
	return ContentBlockStartedEvent{
		eventBase:     eventBase{sequence: sequence},
		eventPosition: eventPosition{outputIndex: outputIndex, blockIndex: blockIndex},
		contentKind:   contentKind,
	}, nil
}

// Kind 返回内容块开始类别。
func (ContentBlockStartedEvent) Kind() EventKind {
	return EventContentBlockStarted
}

// OutputIndex 返回响应输出项索引。
func (event ContentBlockStartedEvent) OutputIndex() uint32 {
	return event.outputIndex
}

// BlockIndex 返回输出项内的内容块索引。
func (event ContentBlockStartedEvent) BlockIndex() uint32 {
	return event.blockIndex
}

// ContentKind 返回开始内容块的稳定类别。
func (event ContentBlockStartedEvent) ContentKind() ContentKind {
	return event.contentKind
}

// isStreamEvent 将 ContentBlockStartedEvent 限制在 Canonical 事件联合类型内。
func (ContentBlockStartedEvent) isStreamEvent() {}

// TextDeltaEvent 是指定内容块的普通文本增量。
type TextDeltaEvent struct {
	eventBase
	eventPosition
	delta string
}

// NewTextDeltaEvent 创建允许空白但不允许空值或控制字符的文本增量。
func NewTextDeltaEvent(
	sequence uint64,
	outputIndex uint32,
	blockIndex uint32,
	delta string,
) (TextDeltaEvent, error) {
	if !isValidDelta(delta) {
		return TextDeltaEvent{}, ErrInvalidEvent
	}
	return TextDeltaEvent{
		eventBase:     eventBase{sequence: sequence},
		eventPosition: eventPosition{outputIndex: outputIndex, blockIndex: blockIndex},
		delta:         delta,
	}, nil
}

// Kind 返回普通文本增量类别。
func (TextDeltaEvent) Kind() EventKind {
	return EventTextDelta
}

// OutputIndex 返回响应输出项索引。
func (event TextDeltaEvent) OutputIndex() uint32 {
	return event.outputIndex
}

// BlockIndex 返回输出项内的内容块索引。
func (event TextDeltaEvent) BlockIndex() uint32 {
	return event.blockIndex
}

// Delta 返回必须按顺序拼接的文本片段。
func (event TextDeltaEvent) Delta() string {
	return event.delta
}

// isStreamEvent 将 TextDeltaEvent 限制在 Canonical 事件联合类型内。
func (TextDeltaEvent) isStreamEvent() {}

// TextCompletedEvent 是指定内容块的完整普通文本终值。
//
// Provider Decoder 可用它校验增量聚合结果，或承载只在完成事件出现的文本。
type TextCompletedEvent struct {
	eventBase
	eventPosition
	text string
}

// NewTextCompletedEvent 创建普通文本终值事件。
func NewTextCompletedEvent(
	sequence uint64,
	outputIndex uint32,
	blockIndex uint32,
	text string,
) (TextCompletedEvent, error) {
	if !isNonBlankText(text) {
		return TextCompletedEvent{}, ErrInvalidEvent
	}
	return TextCompletedEvent{
		eventBase:     eventBase{sequence: sequence},
		eventPosition: eventPosition{outputIndex: outputIndex, blockIndex: blockIndex},
		text:          text,
	}, nil
}

// Kind 返回普通文本终值类别。
func (TextCompletedEvent) Kind() EventKind {
	return EventTextCompleted
}

// OutputIndex 返回响应输出项索引。
func (event TextCompletedEvent) OutputIndex() uint32 {
	return event.outputIndex
}

// BlockIndex 返回输出项内的内容块索引。
func (event TextCompletedEvent) BlockIndex() uint32 {
	return event.blockIndex
}

// Text 返回指定内容块的完整普通文本。
func (event TextCompletedEvent) Text() string {
	return event.text
}

// isStreamEvent 将 TextCompletedEvent 限制在 Canonical 事件联合类型内。
func (TextCompletedEvent) isStreamEvent() {}

// RefusalDeltaEvent 是指定内容块的模型拒绝增量。
type RefusalDeltaEvent struct {
	eventBase
	eventPosition
	delta string
}

// NewRefusalDeltaEvent 创建与普通文本分离的模型拒绝增量。
func NewRefusalDeltaEvent(
	sequence uint64,
	outputIndex uint32,
	blockIndex uint32,
	delta string,
) (RefusalDeltaEvent, error) {
	if !isValidDelta(delta) {
		return RefusalDeltaEvent{}, ErrInvalidEvent
	}
	return RefusalDeltaEvent{
		eventBase:     eventBase{sequence: sequence},
		eventPosition: eventPosition{outputIndex: outputIndex, blockIndex: blockIndex},
		delta:         delta,
	}, nil
}

// Kind 返回模型拒绝增量类别。
func (RefusalDeltaEvent) Kind() EventKind {
	return EventRefusalDelta
}

// OutputIndex 返回响应输出项索引。
func (event RefusalDeltaEvent) OutputIndex() uint32 {
	return event.outputIndex
}

// BlockIndex 返回输出项内的内容块索引。
func (event RefusalDeltaEvent) BlockIndex() uint32 {
	return event.blockIndex
}

// Delta 返回必须按顺序拼接的模型拒绝片段。
func (event RefusalDeltaEvent) Delta() string {
	return event.delta
}

// isStreamEvent 将 RefusalDeltaEvent 限制在 Canonical 事件联合类型内。
func (RefusalDeltaEvent) isStreamEvent() {}

// RefusalCompletedEvent 是指定内容块的完整模型拒绝终值。
type RefusalCompletedEvent struct {
	eventBase
	eventPosition
	refusal string
}

// NewRefusalCompletedEvent 创建模型拒绝终值事件。
func NewRefusalCompletedEvent(
	sequence uint64,
	outputIndex uint32,
	blockIndex uint32,
	refusal string,
) (RefusalCompletedEvent, error) {
	if !isNonBlankText(refusal) {
		return RefusalCompletedEvent{}, ErrInvalidEvent
	}
	return RefusalCompletedEvent{
		eventBase:     eventBase{sequence: sequence},
		eventPosition: eventPosition{outputIndex: outputIndex, blockIndex: blockIndex},
		refusal:       refusal,
	}, nil
}

// Kind 返回模型拒绝终值类别。
func (RefusalCompletedEvent) Kind() EventKind {
	return EventRefusalCompleted
}

// OutputIndex 返回响应输出项索引。
func (event RefusalCompletedEvent) OutputIndex() uint32 {
	return event.outputIndex
}

// BlockIndex 返回输出项内的内容块索引。
func (event RefusalCompletedEvent) BlockIndex() uint32 {
	return event.blockIndex
}

// Refusal 返回完整模型拒绝说明。
func (event RefusalCompletedEvent) Refusal() string {
	return event.refusal
}

// isStreamEvent 将 RefusalCompletedEvent 限制在 Canonical 事件联合类型内。
func (RefusalCompletedEvent) isStreamEvent() {}

// ReasoningDeltaKind 区分可见 thinking 与不可见签名的增量。
type ReasoningDeltaKind string

const (
	// ReasoningDeltaThinking 表示可见 thinking 文本增量。
	ReasoningDeltaThinking ReasoningDeltaKind = "thinking"
	// ReasoningDeltaSignature 表示必须原样保留的签名增量。
	ReasoningDeltaSignature ReasoningDeltaKind = "signature"
)

// IsValid 判断 reasoning 增量类别是否已经注册。
func (kind ReasoningDeltaKind) IsValid() bool {
	return kind == ReasoningDeltaThinking || kind == ReasoningDeltaSignature
}

// ReasoningDeltaEvent 是 thinking 或 signature 的类型化增量。
type ReasoningDeltaEvent struct {
	eventBase
	eventPosition
	deltaKind ReasoningDeltaKind
	delta     string
}

// NewReasoningDeltaEvent 创建不会退化为普通文本的 reasoning 增量。
func NewReasoningDeltaEvent(
	sequence uint64,
	outputIndex uint32,
	blockIndex uint32,
	deltaKind ReasoningDeltaKind,
	delta string,
) (ReasoningDeltaEvent, error) {
	if !deltaKind.IsValid() || !isValidDelta(delta) {
		return ReasoningDeltaEvent{}, ErrInvalidEvent
	}
	return ReasoningDeltaEvent{
		eventBase:     eventBase{sequence: sequence},
		eventPosition: eventPosition{outputIndex: outputIndex, blockIndex: blockIndex},
		deltaKind:     deltaKind,
		delta:         delta,
	}, nil
}

// Kind 返回 reasoning 增量类别。
func (ReasoningDeltaEvent) Kind() EventKind {
	return EventReasoningDelta
}

// OutputIndex 返回响应输出项索引。
func (event ReasoningDeltaEvent) OutputIndex() uint32 {
	return event.outputIndex
}

// BlockIndex 返回输出项内的内容块索引。
func (event ReasoningDeltaEvent) BlockIndex() uint32 {
	return event.blockIndex
}

// DeltaKind 返回 thinking 或 signature 类型。
func (event ReasoningDeltaEvent) DeltaKind() ReasoningDeltaKind {
	return event.deltaKind
}

// Delta 返回必须按同类顺序拼接的 reasoning 片段。
func (event ReasoningDeltaEvent) Delta() string {
	return event.delta
}

// isStreamEvent 将 ReasoningDeltaEvent 限制在 Canonical 事件联合类型内。
func (ReasoningDeltaEvent) isStreamEvent() {}

// ReasoningCompletedEvent 是指定内容块的完整 reasoning 连续性终值。
type ReasoningCompletedEvent struct {
	eventBase
	eventPosition
	content ReasoningContent
}

// NewReasoningCompletedEvent 创建保留签名或加密数据的 reasoning 终值事件。
func NewReasoningCompletedEvent(
	sequence uint64,
	outputIndex uint32,
	blockIndex uint32,
	content ReasoningContent,
) (ReasoningCompletedEvent, error) {
	if !content.IsValid() {
		return ReasoningCompletedEvent{}, ErrInvalidEvent
	}
	return ReasoningCompletedEvent{
		eventBase:     eventBase{sequence: sequence},
		eventPosition: eventPosition{outputIndex: outputIndex, blockIndex: blockIndex},
		content:       content,
	}, nil
}

// Kind 返回 reasoning 终值类别。
func (ReasoningCompletedEvent) Kind() EventKind {
	return EventReasoningCompleted
}

// OutputIndex 返回响应输出项索引。
func (event ReasoningCompletedEvent) OutputIndex() uint32 {
	return event.outputIndex
}

// BlockIndex 返回输出项内的内容块索引。
func (event ReasoningCompletedEvent) BlockIndex() uint32 {
	return event.blockIndex
}

// Content 返回完整 reasoning 连续性值对象。
func (event ReasoningCompletedEvent) Content() ReasoningContent {
	return event.content
}

// isStreamEvent 将 ReasoningCompletedEvent 限制在 Canonical 事件联合类型内。
func (ReasoningCompletedEvent) isStreamEvent() {}

// ToolCallStartedEvent 表示有明确 call ID 和工具名的调用开始。
type ToolCallStartedEvent struct {
	eventBase
	eventPosition
	callID string
	name   string
}

// NewToolCallStartedEvent 创建工具调用开始事件。
func NewToolCallStartedEvent(
	sequence uint64,
	outputIndex uint32,
	blockIndex uint32,
	callID string,
	name string,
) (ToolCallStartedEvent, error) {
	if !isCanonicalOpaqueID(callID) || !isToolName(name) {
		return ToolCallStartedEvent{}, ErrInvalidEvent
	}
	return ToolCallStartedEvent{
		eventBase:     eventBase{sequence: sequence},
		eventPosition: eventPosition{outputIndex: outputIndex, blockIndex: blockIndex},
		callID:        callID,
		name:          name,
	}, nil
}

// Kind 返回工具调用开始类别。
func (ToolCallStartedEvent) Kind() EventKind {
	return EventToolCallStarted
}

// OutputIndex 返回响应输出项索引。
func (event ToolCallStartedEvent) OutputIndex() uint32 {
	return event.outputIndex
}

// BlockIndex 返回输出项内的内容块索引。
func (event ToolCallStartedEvent) BlockIndex() uint32 {
	return event.blockIndex
}

// CallID 返回后续参数增量和工具结果使用的精确调用 ID。
func (event ToolCallStartedEvent) CallID() string {
	return event.callID
}

// Name 返回调用的精确工具名。
func (event ToolCallStartedEvent) Name() string {
	return event.name
}

// isStreamEvent 将 ToolCallStartedEvent 限制在 Canonical 事件联合类型内。
func (ToolCallStartedEvent) isStreamEvent() {}

// ToolArgumentsDeltaEvent 是一个明确工具调用的 JSON 参数片段。
type ToolArgumentsDeltaEvent struct {
	eventBase
	eventPosition
	callID string
	delta  string
}

// NewToolArgumentsDeltaEvent 创建只负责保真、不提前修复 JSON 的参数增量。
func NewToolArgumentsDeltaEvent(
	sequence uint64,
	outputIndex uint32,
	blockIndex uint32,
	callID string,
	delta string,
) (ToolArgumentsDeltaEvent, error) {
	if !isCanonicalOpaqueID(callID) || !isValidDelta(delta) {
		return ToolArgumentsDeltaEvent{}, ErrInvalidEvent
	}
	return ToolArgumentsDeltaEvent{
		eventBase:     eventBase{sequence: sequence},
		eventPosition: eventPosition{outputIndex: outputIndex, blockIndex: blockIndex},
		callID:        callID,
		delta:         delta,
	}, nil
}

// Kind 返回工具参数增量类别。
func (ToolArgumentsDeltaEvent) Kind() EventKind {
	return EventToolArgumentsDelta
}

// OutputIndex 返回响应输出项索引。
func (event ToolArgumentsDeltaEvent) OutputIndex() uint32 {
	return event.outputIndex
}

// BlockIndex 返回输出项内的内容块索引。
func (event ToolArgumentsDeltaEvent) BlockIndex() uint32 {
	return event.blockIndex
}

// CallID 返回参数所属的精确工具调用 ID。
func (event ToolArgumentsDeltaEvent) CallID() string {
	return event.callID
}

// Delta 返回必须按事件顺序拼接的原始 JSON 片段。
func (event ToolArgumentsDeltaEvent) Delta() string {
	return event.delta
}

// isStreamEvent 将 ToolArgumentsDeltaEvent 限制在 Canonical 事件联合类型内。
func (ToolArgumentsDeltaEvent) isStreamEvent() {}

// ToolCallCompletedEvent 是拥有完整 JSON Object 参数的工具调用。
type ToolCallCompletedEvent struct {
	eventBase
	eventPosition
	callID    string
	name      string
	arguments []byte
}

// NewToolCallCompletedEvent 创建工具调用完成事件并复制完整参数。
func NewToolCallCompletedEvent(
	sequence uint64,
	outputIndex uint32,
	blockIndex uint32,
	callID string,
	name string,
	arguments []byte,
) (ToolCallCompletedEvent, error) {
	if !isCanonicalOpaqueID(callID) || !isToolName(name) || !isJSONObject(arguments) {
		return ToolCallCompletedEvent{}, ErrInvalidEvent
	}
	return ToolCallCompletedEvent{
		eventBase:     eventBase{sequence: sequence},
		eventPosition: eventPosition{outputIndex: outputIndex, blockIndex: blockIndex},
		callID:        callID,
		name:          name,
		arguments:     cloneBytes(arguments),
	}, nil
}

// Kind 返回工具调用完成类别。
func (ToolCallCompletedEvent) Kind() EventKind {
	return EventToolCallCompleted
}

// OutputIndex 返回响应输出项索引。
func (event ToolCallCompletedEvent) OutputIndex() uint32 {
	return event.outputIndex
}

// BlockIndex 返回输出项内的内容块索引。
func (event ToolCallCompletedEvent) BlockIndex() uint32 {
	return event.blockIndex
}

// CallID 返回完成调用的精确 ID。
func (event ToolCallCompletedEvent) CallID() string {
	return event.callID
}

// Name 返回完成调用的工具名。
func (event ToolCallCompletedEvent) Name() string {
	return event.name
}

// Arguments 返回不能修改事件内部状态的完整 JSON Object 副本。
func (event ToolCallCompletedEvent) Arguments() []byte {
	return cloneBytes(event.arguments)
}

// isStreamEvent 将 ToolCallCompletedEvent 限制在 Canonical 事件联合类型内。
func (ToolCallCompletedEvent) isStreamEvent() {}

// ContentBlockCompletedEvent 表示指定内容块已收到明确结束信号。
type ContentBlockCompletedEvent struct {
	eventBase
	eventPosition
}

// NewContentBlockCompletedEvent 创建内容块完成事件。
func NewContentBlockCompletedEvent(
	sequence uint64,
	outputIndex uint32,
	blockIndex uint32,
) ContentBlockCompletedEvent {
	return ContentBlockCompletedEvent{
		eventBase:     eventBase{sequence: sequence},
		eventPosition: eventPosition{outputIndex: outputIndex, blockIndex: blockIndex},
	}
}

// Kind 返回内容块完成类别。
func (ContentBlockCompletedEvent) Kind() EventKind {
	return EventContentBlockCompleted
}

// OutputIndex 返回响应输出项索引。
func (event ContentBlockCompletedEvent) OutputIndex() uint32 {
	return event.outputIndex
}

// BlockIndex 返回输出项内的内容块索引。
func (event ContentBlockCompletedEvent) BlockIndex() uint32 {
	return event.blockIndex
}

// isStreamEvent 将 ContentBlockCompletedEvent 限制在 Canonical 事件联合类型内。
func (ContentBlockCompletedEvent) isStreamEvent() {}

// UsageUpdatedEvent 是 Provider 返回的最新累计 token 快照。
type UsageUpdatedEvent struct {
	eventBase
	usage Usage
}

// NewUsageUpdatedEvent 创建内部一致的累计 usage 事件。
func NewUsageUpdatedEvent(sequence uint64, usage Usage) (UsageUpdatedEvent, error) {
	if !usage.IsValid() {
		return UsageUpdatedEvent{}, ErrInvalidEvent
	}
	return UsageUpdatedEvent{
		eventBase: eventBase{sequence: sequence},
		usage:     usage,
	}, nil
}

// Kind 返回 usage 更新类别。
func (UsageUpdatedEvent) Kind() EventKind {
	return EventUsageUpdated
}

// Usage 返回累计 token 快照。
func (event UsageUpdatedEvent) Usage() Usage {
	return event.usage
}

// isStreamEvent 将 UsageUpdatedEvent 限制在 Canonical 事件联合类型内。
func (UsageUpdatedEvent) isStreamEvent() {}

// StopReason 是 Provider 完成语义的规范分类。
type StopReason string

const (
	// StopReasonEndTurn 表示模型正常结束本轮输出。
	StopReasonEndTurn StopReason = "end_turn"
	// StopReasonStopSequence 表示命中客户端提供的停止序列。
	StopReasonStopSequence StopReason = "stop_sequence"
	// StopReasonMaxTokens 表示达到最大输出 token。
	StopReasonMaxTokens StopReason = "max_tokens"
	// StopReasonToolUse 表示模型结束文本并等待工具结果。
	StopReasonToolUse StopReason = "tool_use"
	// StopReasonContentFilter 表示输出被内容策略停止。
	StopReasonContentFilter StopReason = "content_filter"
	// StopReasonCancelled 表示调用方主动取消响应。
	StopReasonCancelled StopReason = "cancelled"
)

// IsValid 判断停止原因是否可以无歧义渲染到客户端协议。
func (reason StopReason) IsValid() bool {
	switch reason {
	case StopReasonEndTurn,
		StopReasonStopSequence,
		StopReasonMaxTokens,
		StopReasonToolUse,
		StopReasonContentFilter,
		StopReasonCancelled:
		return true
	default:
		return false
	}
}

// ResponseCompletedEvent 表示收到 Provider 的明确成功终态。
type ResponseCompletedEvent struct {
	eventBase
	stopReason   StopReason
	stopSequence string
	usage        Usage
}

// NewResponseCompletedEvent 创建不会由缺失输出伪造的明确完成事件。
func NewResponseCompletedEvent(
	sequence uint64,
	stopReason StopReason,
	stopSequence string,
	usage Usage,
) (ResponseCompletedEvent, error) {
	if !stopReason.IsValid() || !usage.IsValid() {
		return ResponseCompletedEvent{}, ErrInvalidEvent
	}
	if stopReason == StopReasonStopSequence {
		if !isNonBlankText(stopSequence) {
			return ResponseCompletedEvent{}, ErrInvalidEvent
		}
	} else if stopSequence != "" {
		return ResponseCompletedEvent{}, ErrInvalidEvent
	}
	return ResponseCompletedEvent{
		eventBase:    eventBase{sequence: sequence},
		stopReason:   stopReason,
		stopSequence: stopSequence,
		usage:        usage,
	}, nil
}

// Kind 返回响应完成类别。
func (ResponseCompletedEvent) Kind() EventKind {
	return EventResponseCompleted
}

// StopReason 返回规范结束原因。
func (event ResponseCompletedEvent) StopReason() StopReason {
	return event.stopReason
}

// StopSequence 返回命中的停止序列，非对应原因时为空。
func (event ResponseCompletedEvent) StopSequence() string {
	return event.stopSequence
}

// Usage 返回最终累计 token 快照。
func (event ResponseCompletedEvent) Usage() Usage {
	return event.usage
}

// isStreamEvent 将 ResponseCompletedEvent 限制在 Canonical 事件联合类型内。
func (ResponseCompletedEvent) isStreamEvent() {}

// ResponseFailure 是不含 Provider 原始正文和凭据的低敏失败。
type ResponseFailure struct {
	code        string
	safeMessage string
	retryable   bool
}

// NewResponseFailure 创建可观察但不会传播原始上游正文的失败。
func NewResponseFailure(
	code string,
	safeMessage string,
	retryable bool,
) (ResponseFailure, error) {
	if !isCanonicalOpaqueID(code) || (safeMessage != "" && !isNonBlankText(safeMessage)) {
		return ResponseFailure{}, ErrInvalidEvent
	}
	return ResponseFailure{
		code:        code,
		safeMessage: safeMessage,
		retryable:   retryable,
	}, nil
}

// Code 返回失败分类代码。
func (failure ResponseFailure) Code() string {
	return failure.code
}

// SafeMessage 返回经过 Adapter 脱敏的可选说明。
func (failure ResponseFailure) SafeMessage() string {
	return failure.safeMessage
}

// Retryable 返回失败是否满足上层安全重试的必要条件。
//
// 上层仍需结合是否已产生可见输出或工具调用决定能否重试。
func (failure ResponseFailure) Retryable() bool {
	return failure.retryable
}

// IsValid 判断低敏失败仍满足构造不变量。
func (failure ResponseFailure) IsValid() bool {
	_, err := NewResponseFailure(failure.code, failure.safeMessage, failure.retryable)
	return err == nil
}

// ResponseFailedEvent 是响应明确失败或提前断流的终态事件。
type ResponseFailedEvent struct {
	eventBase
	failure ResponseFailure
}

// NewResponseFailedEvent 创建只有低敏分类信息的失败终态。
func NewResponseFailedEvent(
	sequence uint64,
	failure ResponseFailure,
) (ResponseFailedEvent, error) {
	if !failure.IsValid() {
		return ResponseFailedEvent{}, ErrInvalidEvent
	}
	return ResponseFailedEvent{
		eventBase: eventBase{sequence: sequence},
		failure:   failure,
	}, nil
}

// Kind 返回响应失败类别。
func (ResponseFailedEvent) Kind() EventKind {
	return EventResponseFailed
}

// Failure 返回经过脱敏的失败快照。
func (event ResponseFailedEvent) Failure() ResponseFailure {
	return event.failure
}

// isStreamEvent 将 ResponseFailedEvent 限制在 Canonical 事件联合类型内。
func (ResponseFailedEvent) isStreamEvent() {}
