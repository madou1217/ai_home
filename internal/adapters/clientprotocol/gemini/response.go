package gemini

import (
	"bytes"
	"encoding/json"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
)

// generateContentResponse 是 generateContent 的响应 envelope。
type generateContentResponse struct {
	Candidates    []candidateDTO    `json:"candidates"`
	UsageMetadata *usageMetadataDTO `json:"usageMetadata,omitempty"`
	ModelVersion  string            `json:"modelVersion,omitempty"`
	ResponseID    string            `json:"responseId,omitempty"`
}

// candidateDTO 是单个候选结果。
type candidateDTO struct {
	Content      contentOutDTO `json:"content"`
	FinishReason string        `json:"finishReason,omitempty"`
	Index        int           `json:"index"`
}

// contentOutDTO 是输出内容。
type contentOutDTO struct {
	Role  string       `json:"role"`
	Parts []partOutDTO `json:"parts"`
}

// partOutDTO 是输出内容块联合类型。
type partOutDTO struct {
	Text         *string          `json:"text,omitempty"`
	Thought      bool             `json:"thought,omitempty"`
	FunctionCall *functionCallOut `json:"functionCall,omitempty"`
}

// functionCallOut 是输出侧的模型工具调用。
type functionCallOut struct {
	ID   string          `json:"id,omitempty"`
	Name string          `json:"name"`
	Args json.RawMessage `json:"args"`
}

// usageMetadataDTO 是 Gemini 的用量字段。
type usageMetadataDTO struct {
	PromptTokenCount        uint64 `json:"promptTokenCount"`
	CandidatesTokenCount    uint64 `json:"candidatesTokenCount"`
	TotalTokenCount         uint64 `json:"totalTokenCount"`
	ThoughtsTokenCount      uint64 `json:"thoughtsTokenCount,omitempty"`
	CachedContentTokenCount uint64 `json:"cachedContentTokenCount,omitempty"`
}

// responseState 累积 Canonical 事件并产出 Gemini 响应。
//
// 流式与非流式共用同一状态机，避免两条输出路径各自解释事件而产生分歧。
type responseState struct {
	request inference.Request
	created time.Time

	parts    []partOutDTO
	usage    usageMetadataDTO
	hasUsage bool
	finish   string
	// failure 记录失败终态；非流式聚合器据此拒绝编码。
	failure   inference.ResponseFailure
	hasFailed bool
	completed bool
	// started 表示已经收到过首个事件。
	started bool
}

// newResponseState 创建绑定单个请求的响应状态。
func newResponseState(request inference.Request, createdAt time.Time) *responseState {
	return &responseState{request: request, created: createdAt}
}

// apply 把一个 Canonical 事件折叠进状态。
func (state *responseState) apply(event inference.StreamEvent) error {
	if state.hasFailed || state.completed {
		// 终态之后不再接受事件：继续接受会静默产生第二个 finishReason。
		return ErrInvalidEventSequence
	}
	state.started = true
	switch typed := event.(type) {
	case inference.ResponseStartedEvent:
		return nil
	case inference.OutputItemStartedEvent:
		return nil
	case inference.ContentBlockStartedEvent:
		return nil
	case inference.TextDeltaEvent:
		return state.appendText(typed.Delta(), false)
	case inference.TextCompletedEvent:
		return state.replaceText(typed.Text(), false)
	case inference.ReasoningDeltaEvent:
		return state.appendText(typed.Delta(), true)
	case inference.ReasoningCompletedEvent:
		return state.replaceText(typed.Content().Text(), true)
	case inference.ToolCallStartedEvent:
		return state.startToolCall(typed.CallID(), typed.Name())
	case inference.ToolArgumentsDeltaEvent:
		// Gemini 的 functionCall.args 是对象而不是字符串增量，无法逐段表达；
		// 这里只记录，真正的 args 在 ToolCallCompleted 时一次写入。
		return nil
	case inference.ToolCallCompletedEvent:
		return state.completeToolCall(typed.CallID(), typed.Name(), typed.Arguments())
	case inference.ContentBlockCompletedEvent:
		return nil
	case inference.OutputItemCompletedEvent:
		return nil
	case inference.UsageUpdatedEvent:
		state.applyUsage(typed.Usage())
		return nil
	case inference.ResponseCompletedEvent:
		reason, err := mapFinishReason(typed.StopReason())
		if err != nil {
			return err
		}
		state.finish = reason
		state.applyUsage(typed.Usage())
		state.completed = true
		return nil
	case inference.ResponseFailedEvent:
		state.failure = typed.Failure()
		state.hasFailed = true
		return nil
	default:
		// 未建模的事件（引用、网络搜索等）在 Gemini 线协议里没有对应结构。
		return ErrUnsupportedResponseEvent
	}
}

// appendText 把增量追加到最后一个同类型文本块，没有则新建。
func (state *responseState) appendText(delta string, thought bool) error {
	if delta == "" {
		return nil
	}
	if index := state.lastTextPartIndex(thought); index >= 0 {
		merged := derefString(state.parts[index].Text) + delta
		state.parts[index].Text = &merged
		return nil
	}
	text := delta
	state.parts = append(state.parts, partOutDTO{Text: &text, Thought: thought})
	return nil
}

// replaceText 用完整文本替换最后一个同类型文本块，没有则新建。
func (state *responseState) replaceText(text string, thought bool) error {
	if text == "" {
		return nil
	}
	if index := state.lastTextPartIndex(thought); index >= 0 {
		value := text
		state.parts[index].Text = &value
		return nil
	}
	value := text
	state.parts = append(state.parts, partOutDTO{Text: &value, Thought: thought})
	return nil
}

// lastTextPartIndex 返回最后一个同类型文本块的下标，没有则返回 -1。
func (state *responseState) lastTextPartIndex(thought bool) int {
	for index := len(state.parts) - 1; index >= 0; index-- {
		if state.parts[index].Text != nil && state.parts[index].Thought == thought {
			return index
		}
	}
	return -1
}

// startToolCall 新建一个等待参数的工具调用块。
func (state *responseState) startToolCall(callID string, name string) error {
	if strings.TrimSpace(name) == "" {
		return ErrInvalidEventSequence
	}
	state.parts = append(state.parts, partOutDTO{
		FunctionCall: &functionCallOut{
			ID:   callID,
			Name: name,
			Args: json.RawMessage("{}"),
		},
	})
	return nil
}

// completeToolCall 写入工具调用的最终参数。
func (state *responseState) completeToolCall(
	callID string,
	name string,
	arguments []byte,
) error {
	args := arguments
	if len(args) == 0 {
		args = []byte("{}")
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, args); err != nil {
		return ErrInvalidEventSequence
	}
	for index := len(state.parts) - 1; index >= 0; index-- {
		call := state.parts[index].FunctionCall
		if call == nil {
			continue
		}
		if call.ID == callID || (callID == "" && call.Name == name) {
			call.Args = json.RawMessage(compact.Bytes())
			if callID != "" {
				call.ID = callID
			}
			return nil
		}
	}
	// 没有对应的开始事件：按完成事件直接补一个完整块，避免丢失工具调用。
	state.parts = append(state.parts, partOutDTO{
		FunctionCall: &functionCallOut{
			ID:   callID,
			Name: name,
			Args: json.RawMessage(compact.Bytes()),
		},
	})
	return nil
}

// applyUsage 合并一次用量快照，保留更大的值。
//
// 上游可能在流中途先给部分用量、收尾再给完整值；取较大值避免把已知计数写回更小。
func (state *responseState) applyUsage(usage inference.Usage) {
	if !usage.IsValid() {
		return
	}
	state.hasUsage = true
	state.usage.PromptTokenCount = maxUint64(state.usage.PromptTokenCount, usage.InputTokens())
	state.usage.CandidatesTokenCount = maxUint64(
		state.usage.CandidatesTokenCount,
		usage.OutputTokens(),
	)
	state.usage.TotalTokenCount = maxUint64(state.usage.TotalTokenCount, usage.TotalTokens())
	state.usage.ThoughtsTokenCount = maxUint64(
		state.usage.ThoughtsTokenCount,
		usage.ReasoningTokens(),
	)
	state.usage.CachedContentTokenCount = maxUint64(
		state.usage.CachedContentTokenCount,
		usage.CachedInputTokens(),
	)
}

// buildResponse 编码完整的 Gemini 响应。
func (state *responseState) buildResponse() (generateContentResponse, error) {
	if state.hasFailed {
		return generateContentResponse{}, ErrResponseFailed
	}
	if !state.completed {
		return generateContentResponse{}, ErrResponseNotCompleted
	}
	response := generateContentResponse{
		Candidates: []candidateDTO{{
			Content: contentOutDTO{
				Role:  "model",
				Parts: state.partsOrEmpty(),
			},
			FinishReason: state.finish,
			Index:        0,
		}},
	}
	if state.hasUsage {
		usage := state.usage
		response.UsageMetadata = &usage
	}
	return response, nil
}

// partsOrEmpty 保证 candidates[0].content.parts 始终是数组而不是 null。
func (state *responseState) partsOrEmpty() []partOutDTO {
	if len(state.parts) == 0 {
		return []partOutDTO{}
	}
	return state.parts
}

// candidateFrame 构造一个只带当前增量的流式候选帧。
func (state *responseState) candidateFrame(parts []partOutDTO) candidateDTO {
	return candidateDTO{
		Content: contentOutDTO{Role: "model", Parts: parts},
		Index:   0,
	}
}

// ResponseAggregator 把 Canonical 事件流聚合为一个非流式 Gemini 响应。
type ResponseAggregator struct {
	state *responseState
}

// NewResponseAggregator 创建固定响应时间的非流式聚合器。
func NewResponseAggregator(
	request inference.Request,
	createdAt time.Time,
) *ResponseAggregator {
	return &ResponseAggregator{state: newResponseState(request, createdAt)}
}

// Add 把一个 Canonical 事件加入聚合状态。
func (aggregator *ResponseAggregator) Add(event inference.StreamEvent) error {
	if aggregator == nil || aggregator.state == nil {
		return ErrInvalidEventSequence
	}
	return aggregator.state.apply(event)
}

// Marshal 只在收到明确成功终态后编码完整 Gemini 响应。
func (aggregator *ResponseAggregator) Marshal() ([]byte, error) {
	if aggregator == nil || aggregator.state == nil {
		return nil, ErrResponseNotCompleted
	}
	response, err := aggregator.state.buildResponse()
	if err != nil {
		return nil, err
	}
	return json.Marshal(response)
}

// StreamRenderer 把 Canonical 事件渲染为 Gemini SSE data 帧。
//
// Gemini 的 SSE 只有 data 行、没有 event 名，因此全部使用 data-only 帧。
type StreamRenderer struct {
	state *responseState
	// terminal 表示已经写出终态帧。
	terminal bool
}

// NewStreamRenderer 创建固定响应时间的流式渲染器。
func NewStreamRenderer(
	request inference.Request,
	createdAt time.Time,
) *StreamRenderer {
	return &StreamRenderer{state: newResponseState(request, createdAt)}
}

// Render 把一个 Canonical 事件渲染为若干 SSE 帧。
func (renderer *StreamRenderer) Render(
	event inference.StreamEvent,
) ([]clientprotocol.RenderedEvent, error) {
	if renderer == nil || renderer.state == nil {
		return nil, ErrInvalidEventSequence
	}
	// 先取增量，再交给状态机；这样帧里携带的是本次新增内容而不是累计内容。
	deltaParts := deltaPartsFor(event)
	if err := renderer.state.apply(event); err != nil {
		return nil, err
	}
	if renderer.terminal {
		return nil, ErrInvalidEventSequence
	}

	switch typed := event.(type) {
	case inference.ResponseFailedEvent:
		renderer.terminal = true
		return renderer.failureFrame(typed.Failure())
	case inference.ResponseCompletedEvent:
		renderer.terminal = true
		return renderer.completionFrames()
	}
	if len(deltaParts) == 0 {
		if _, isUsage := event.(inference.UsageUpdatedEvent); !isUsage {
			return nil, nil
		}
	}
	return renderer.frame(deltaParts, "", false)
}

// Terminal 表示已经渲染过终态帧。
func (renderer *StreamRenderer) Terminal() bool {
	return renderer != nil && renderer.terminal
}

// frame 编码一个 data-only SSE 帧。
func (renderer *StreamRenderer) frame(
	parts []partOutDTO,
	finishReason string,
	withUsage bool,
) ([]clientprotocol.RenderedEvent, error) {
	response := generateContentResponse{
		Candidates: []candidateDTO{renderer.state.candidateFrame(parts)},
	}
	if finishReason != "" {
		response.Candidates[0].FinishReason = finishReason
	}
	if withUsage && renderer.state.hasUsage {
		usage := renderer.state.usage
		response.UsageMetadata = &usage
	}
	return marshalFrame(response)
}

// completionFrames 生成收尾帧：先带 finishReason 与用量，再由传输层结束流。
func (renderer *StreamRenderer) completionFrames() ([]clientprotocol.RenderedEvent, error) {
	return renderer.frame([]partOutDTO{}, renderer.state.finish, true)
}

// failureFrame 生成错误帧。
//
// Gemini 的流式错误仍是 GenerateContentResponse 之外的对象，这里按官方错误 envelope
// 形状输出，让客户端能按 code 分流。
func (renderer *StreamRenderer) failureFrame(
	failure inference.ResponseFailure,
) ([]clientprotocol.RenderedEvent, error) {
	payload := struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Status  string `json:"status"`
		} `json:"error"`
	}{}
	payload.Error.Code = failure.Code()
	payload.Error.Message = failure.SafeMessage()
	payload.Error.Status = "FAILED_PRECONDITION"
	return marshalFrame(payload)
}

// marshalFrame 把任意响应对象编码为 data-only SSE 帧。
func marshalFrame(payload any) ([]clientprotocol.RenderedEvent, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, ErrUnsupportedResponseEvent
	}
	event, err := clientprotocol.NewMarshaledDataEvent(encoded)
	if err != nil {
		return nil, ErrUnsupportedResponseEvent
	}
	return []clientprotocol.RenderedEvent{event}, nil
}

// deltaPartsFor 返回本次事件新增的内容块；非增量事件返回 nil。
func deltaPartsFor(event inference.StreamEvent) []partOutDTO {
	switch typed := event.(type) {
	case inference.TextDeltaEvent:
		if typed.Delta() == "" {
			return nil
		}
		text := typed.Delta()
		return []partOutDTO{{Text: &text}}
	case inference.ReasoningDeltaEvent:
		if typed.Delta() == "" {
			return nil
		}
		text := typed.Delta()
		return []partOutDTO{{Text: &text, Thought: true}}
	case inference.ToolCallCompletedEvent:
		args := typed.Arguments()
		if len(args) == 0 {
			args = []byte("{}")
		}
		var compact bytes.Buffer
		if err := json.Compact(&compact, args); err != nil {
			return nil
		}
		return []partOutDTO{{
			FunctionCall: &functionCallOut{
				ID:   typed.CallID(),
				Name: typed.Name(),
				Args: json.RawMessage(compact.Bytes()),
			},
		}}
	default:
		return nil
	}
}

// mapFinishReason 把 Canonical 终止原因映射为 Gemini finishReason。
//
// 未建模的原因返回错误而不是降级为 OTHER：静默降级会让客户端无法区分
// 「正常结束」和「被安全策略拦截」。
func mapFinishReason(reason inference.StopReason) (string, error) {
	switch reason {
	case inference.StopReasonEndTurn, inference.StopReasonStopSequence:
		return "STOP", nil
	case inference.StopReasonMaxTokens:
		return "MAX_TOKENS", nil
	case inference.StopReasonToolUse:
		// Gemini 在工具调用时仍报 STOP，调用本身体现在 functionCall 内容块里。
		return "STOP", nil
	case inference.StopReasonContentFilter:
		return "SAFETY", nil
	case inference.StopReasonPauseTurn, inference.StopReasonCancelled:
		return "OTHER", nil
	default:
		return "", ErrUnsupportedResponseEvent
	}
}

// derefString 安全解引用可空字符串。
func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// maxUint64 返回两个无符号整数的较大值。
func maxUint64(left uint64, right uint64) uint64 {
	if left > right {
		return left
	}
	return right
}
