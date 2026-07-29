package openairesponses

import (
	"encoding/json"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
)

// RenderedEvent 复用客户端协议层的不可变 SSE 事件值对象。
type RenderedEvent = clientprotocol.RenderedEvent

// responseWireDTO 是流式终态和非流式响应共用的 Responses 对象。
type responseWireDTO struct {
	// ID 是 Provider 响应 ID。
	ID string `json:"id"`
	// Object 固定为 response。
	Object string `json:"object"`
	// CreatedAt 是响应创建 Unix 秒。
	CreatedAt int64 `json:"created_at"`
	// CompletedAt 是响应完成 Unix 秒。
	CompletedAt *int64 `json:"completed_at,omitempty"`
	// Status 是 in_progress、completed 或 failed。
	Status string `json:"status"`
	// Error 是失败终态的低敏错误。
	Error *responseErrorWireDTO `json:"error"`
	// IncompleteDetails 当前成功或失败终态均为空。
	IncompleteDetails *incompleteDetailsWireDTO `json:"incomplete_details"`
	// Model 是上游确认使用的真实模型。
	Model string `json:"model"`
	// Output 是按 output_index 排列的完整输出项。
	Output []json.RawMessage `json:"output"`
	// Usage 是完成终态的累计 token。
	Usage *usageWireDTO `json:"usage"`
	// MaxOutputTokens 是客户端提供的可选输出上限。
	MaxOutputTokens *uint64 `json:"max_output_tokens,omitempty"`
	// ParallelToolCalls 是客户端提供的可选并行工具意图。
	ParallelToolCalls *bool `json:"parallel_tool_calls,omitempty"`
	// PreviousResponseID 是可选 Responses 历史响应引用。
	PreviousResponseID *string `json:"previous_response_id,omitempty"`
	// Store 是客户端提供的可选响应存储意图。
	Store *bool `json:"store,omitempty"`
	// Temperature 是客户端提供的可选采样温度。
	Temperature *float64 `json:"temperature,omitempty"`
	// TopP 是客户端提供的可选 nucleus sampling 概率。
	TopP *float64 `json:"top_p,omitempty"`
	// Truncation 是客户端提供的可选截断策略。
	Truncation *string `json:"truncation,omitempty"`
	// Reasoning 是客户端提供的可选 reasoning 配置。
	Reasoning *reasoningConfigWireDTO `json:"reasoning,omitempty"`
	// Text 是普通文本或 JSON Schema 输出配置。
	Text textConfigWireDTO `json:"text"`
	// ToolChoice 是客户端提供的可选工具选择。
	ToolChoice json.RawMessage `json:"tool_choice,omitempty"`
	// Tools 是客户端声明的函数工具。
	Tools []functionToolWireDTO `json:"tools"`
}

// responseErrorWireDTO 是失败响应中的低敏错误对象。
type responseErrorWireDTO struct {
	// Code 是 Canonical 失败分类代码。
	Code string `json:"code"`
	// Message 是已经脱敏的可选说明。
	Message string `json:"message"`
}

// incompleteDetailsWireDTO 为后续 max_output_tokens 等不完整终态保留类型边界。
type incompleteDetailsWireDTO struct {
	// Reason 是响应未完整结束的稳定原因。
	Reason string `json:"reason"`
}

// usageWireDTO 是 Responses token 使用量。
type usageWireDTO struct {
	// InputTokens 是累计输入 token。
	InputTokens uint64 `json:"input_tokens"`
	// InputTokensDetails 是输入缓存命中与写入明细。
	InputTokensDetails inputTokenDetailsWireDTO `json:"input_tokens_details"`
	// OutputTokens 是累计输出 token。
	OutputTokens uint64 `json:"output_tokens"`
	// OutputTokensDetails 是 reasoning token 明细。
	OutputTokensDetails outputTokenDetailsWireDTO `json:"output_tokens_details"`
	// TotalTokens 是累计总 token。
	TotalTokens uint64 `json:"total_tokens"`
}

// inputTokenDetailsWireDTO 是输入 token 的缓存子集。
type inputTokenDetailsWireDTO struct {
	// CachedTokens 是缓存命中的输入 token。
	CachedTokens uint64 `json:"cached_tokens"`
	// CacheWriteTokens 是写入缓存的输入 token。
	CacheWriteTokens uint64 `json:"cache_write_tokens"`
}

// outputTokenDetailsWireDTO 是输出 token 的 reasoning 子集。
type outputTokenDetailsWireDTO struct {
	// ReasoningTokens 是 reasoning 使用的输出 token。
	ReasoningTokens uint64 `json:"reasoning_tokens"`
}

// messageItemWireDTO 是 Responses Assistant 消息输出项。
type messageItemWireDTO struct {
	// ID 是 Provider 输出项 ID。
	ID string `json:"id"`
	// Type 固定为 message。
	Type string `json:"type"`
	// Status 是 in_progress 或 completed。
	Status string `json:"status"`
	// Role 固定为 assistant。
	Role string `json:"role"`
	// Content 是按 content_index 排列的内容块。
	Content []json.RawMessage `json:"content"`
	// Phase 是可选 commentary 或 final_answer。
	Phase string `json:"phase,omitempty"`
}

// reasoningItemWireDTO 是 Responses reasoning 输出项。
type reasoningItemWireDTO struct {
	// ID 是 Provider 输出项 ID。
	ID string `json:"id"`
	// Type 固定为 reasoning。
	Type string `json:"type"`
	// Status 是 in_progress 或 completed。
	Status string `json:"status"`
	// Summary 是可见 reasoning 摘要。
	Summary []reasoningSummaryWireDTO `json:"summary"`
	// EncryptedContent 是可选加密连续性。
	EncryptedContent string `json:"encrypted_content,omitempty"`
}

// reasoningSummaryWireDTO 是 reasoning summary_text 内容。
type reasoningSummaryWireDTO struct {
	// Type 固定为 summary_text。
	Type string `json:"type"`
	// Text 是完整 reasoning 摘要。
	Text string `json:"text"`
}

// functionCallItemWireDTO 是 Responses function_call 输出项。
type functionCallItemWireDTO struct {
	// ID 是 Provider 输出项 ID。
	ID string `json:"id"`
	// Type 固定为 function_call。
	Type string `json:"type"`
	// Status 是 in_progress 或 completed。
	Status string `json:"status"`
	// CallID 是工具结果必须精确引用的 ID。
	CallID string `json:"call_id"`
	// Name 是函数工具名。
	Name string `json:"name"`
	// Arguments 是完整或当前累计 JSON 参数字符串。
	Arguments string `json:"arguments"`
}

// outputTextWireDTO 是 Responses output_text 内容块。
type outputTextWireDTO struct {
	// Type 固定为 output_text。
	Type string `json:"type"`
	// Text 是当前累计或完整文本。
	Text string `json:"text"`
	// Annotations 是当前尚无引用时的空数组。
	Annotations []json.RawMessage `json:"annotations"`
}

// refusalWireDTO 是 Responses refusal 内容块。
type refusalWireDTO struct {
	// Type 固定为 refusal。
	Type string `json:"type"`
	// Refusal 是当前累计或完整拒绝说明。
	Refusal string `json:"refusal"`
}

// reasoningConfigWireDTO 是 Responses reasoning 请求配置回显。
type reasoningConfigWireDTO struct {
	// Effort 是可选 reasoning 强度。
	Effort string `json:"effort,omitempty"`
	// Summary 是可选 reasoning 摘要模式。
	Summary string `json:"summary,omitempty"`
}

// textConfigWireDTO 是 Responses 文本输出配置。
type textConfigWireDTO struct {
	// Format 是 text 或 json_schema 格式对象。
	Format json.RawMessage `json:"format"`
}

// structuredTextFormatWireDTO 是 Responses JSON Schema 输出格式。
type structuredTextFormatWireDTO struct {
	// Type 固定为 json_schema。
	Type string `json:"type"`
	// Name 是输出合同名称。
	Name string `json:"name"`
	// Description 是可选输出合同说明。
	Description string `json:"description,omitempty"`
	// Schema 是完整 JSON Schema Object。
	Schema json.RawMessage `json:"schema"`
	// Strict 表示是否严格遵循 Schema。
	Strict bool `json:"strict"`
}

// functionToolWireDTO 是 Responses function 工具定义。
type functionToolWireDTO struct {
	// Type 固定为 function。
	Type string `json:"type"`
	// Name 是工具名。
	Name string `json:"name"`
	// Description 是可选工具说明。
	Description string `json:"description,omitempty"`
	// Parameters 是工具输入 JSON Schema。
	Parameters json.RawMessage `json:"parameters"`
	// Strict 保留客户端是否显式提供以及具体布尔值。
	Strict *bool `json:"strict,omitempty"`
}

// namedToolChoiceWireDTO 是 Responses 命名函数工具选择。
type namedToolChoiceWireDTO struct {
	// Type 固定为 function。
	Type string `json:"type"`
	// Name 是必须调用的工具名。
	Name string `json:"name"`
}

// streamEventWireDTO 是 Responses SSE 事件的类型化字段并集。
type streamEventWireDTO struct {
	// Type 是 Responses 事件类型。
	Type string `json:"type"`
	// SequenceNumber 是客户端协议事件的连续序号。
	SequenceNumber uint64 `json:"sequence_number"`
	// Response 是 response 生命周期事件携带的响应对象。
	Response *responseWireDTO `json:"response,omitempty"`
	// OutputIndex 是可选输出项索引。
	OutputIndex *uint32 `json:"output_index,omitempty"`
	// ContentIndex 是可选消息内容索引。
	ContentIndex *uint32 `json:"content_index,omitempty"`
	// SummaryIndex 是可选 reasoning 摘要索引。
	SummaryIndex *uint32 `json:"summary_index,omitempty"`
	// ItemID 是内容或参数所属输出项 ID。
	ItemID string `json:"item_id,omitempty"`
	// Item 是输出项 added 或 done 快照。
	Item json.RawMessage `json:"item,omitempty"`
	// Part 是内容块 added 或 done 快照。
	Part json.RawMessage `json:"part,omitempty"`
	// Delta 是文本、拒绝、reasoning 或工具参数增量。
	Delta string `json:"delta,omitempty"`
	// Text 是文本或 reasoning 完整终值。
	Text string `json:"text,omitempty"`
	// Refusal 是拒绝完整终值。
	Refusal string `json:"refusal,omitempty"`
	// Arguments 是工具参数完整终值。
	Arguments string `json:"arguments,omitempty"`
	// Name 是 function_call_arguments.done 携带的工具名。
	Name string `json:"name,omitempty"`
}

// buildResponseWire 从共享状态构建指定状态的 Responses 对象。
func (state *responseState) buildResponseWire(status string) (responseWireDTO, error) {
	return state.buildResponseWireWithOutputCount(status, len(state.items))
}

// buildResponseWireWithOutputCount 构建只包含连续已曝光输出项的响应对象。
func (state *responseState) buildResponseWireWithOutputCount(
	status string,
	outputCount int,
) (responseWireDTO, error) {
	if outputCount < 0 || outputCount > len(state.items) {
		return responseWireDTO{}, ErrInvalidEventSequence
	}
	reasoning, err := newReasoningConfigWire(state.request)
	if err != nil {
		return responseWireDTO{}, err
	}
	textConfig, err := newTextConfigWire(state.request)
	if err != nil {
		return responseWireDTO{}, err
	}
	toolChoice, err := newToolChoiceWire(state.request)
	if err != nil {
		return responseWireDTO{}, err
	}

	output := make([]json.RawMessage, outputCount)
	for index, item := range state.items[:outputCount] {
		itemStatus := "in_progress"
		if item.completed {
			itemStatus = "completed"
		}
		encoded, err := marshalOutputItem(item, itemStatus)
		if err != nil {
			return responseWireDTO{}, err
		}
		output[index] = encoded
	}

	response := responseWireDTO{
		ID:                 state.responseID,
		Object:             "response",
		CreatedAt:          state.createdAt,
		Status:             status,
		Model:              state.model,
		Output:             output,
		MaxOutputTokens:    optionalUint64(state.request.MaxOutputTokens()),
		ParallelToolCalls:  optionalParallelToolCalls(state.request),
		PreviousResponseID: previousResponseID(state.request),
		Store:              optionalStore(state.request),
		Temperature:        optionalTemperature(state.request),
		TopP:               optionalTopP(state.request),
		Truncation:         optionalTruncation(state.request),
		Reasoning:          reasoning,
		Text:               textConfig,
		ToolChoice:         toolChoice,
		Tools:              newFunctionToolsWire(state.request),
	}
	if status == "completed" {
		completedAt := state.createdAt
		response.CompletedAt = &completedAt
		usage := newUsageWire(state.usage)
		response.Usage = &usage
	}
	if status == "failed" && state.hasFailure {
		response.Error = &responseErrorWireDTO{
			Code:    state.failure.Code(),
			Message: state.failure.SafeMessage(),
		}
	}
	return response, nil
}

// newReasoningConfigWire 编码 Responses 可表达的 effort reasoning 配置。
func newReasoningConfigWire(
	request inference.Request,
) (*reasoningConfigWireDTO, error) {
	config, found := request.Reasoning()
	if !found {
		return nil, nil
	}
	if config.Mode() != inference.ReasoningModeEffort {
		return nil, ErrUnsupportedResponseEvent
	}
	return &reasoningConfigWireDTO{
		Effort:  string(config.Effort()),
		Summary: string(config.Summary()),
	}, nil
}

// newTextConfigWire 编码普通文本或 JSON Schema 输出配置。
func newTextConfigWire(request inference.Request) (textConfigWireDTO, error) {
	output, found := request.StructuredOutput()
	if !found {
		return textConfigWireDTO{
			Format: json.RawMessage(`{"type":"text"}`),
		}, nil
	}
	format, err := json.Marshal(structuredTextFormatWireDTO{
		Type:        "json_schema",
		Name:        output.Name(),
		Description: output.Description(),
		Schema:      json.RawMessage(output.Schema()),
		Strict:      output.Strict(),
	})
	if err != nil {
		return textConfigWireDTO{}, err
	}
	return textConfigWireDTO{Format: format}, nil
}

// newToolChoiceWire 编码字符串模式或命名 function 工具选择。
func newToolChoiceWire(request inference.Request) (json.RawMessage, error) {
	choice, found := request.ToolChoice()
	if !found {
		return nil, nil
	}
	if choice.Mode() == inference.ToolChoiceNamed {
		return json.Marshal(namedToolChoiceWireDTO{
			Type: "function",
			Name: choice.Name(),
		})
	}
	return json.Marshal(string(choice.Mode()))
}

// newFunctionToolsWire 编码请求中全部函数工具及显式 strict 值。
func newFunctionToolsWire(request inference.Request) []functionToolWireDTO {
	definitions := request.Tools()
	tools := make([]functionToolWireDTO, len(definitions))
	for index, definition := range definitions {
		strict, specified := definition.Strict()
		var strictValue *bool
		if specified {
			strictValue = &strict
		}
		tools[index] = functionToolWireDTO{
			Type:        "function",
			Name:        definition.Name(),
			Description: definition.Description(),
			Parameters:  json.RawMessage(definition.InputSchema()),
			Strict:      strictValue,
		}
	}
	return tools
}

// marshalOutputItem 将单个聚合输出项编码为严格 wire DTO。
func marshalOutputItem(item *outputItemState, status string) (json.RawMessage, error) {
	switch item.kind {
	case inference.OutputItemMessage:
		return marshalMessageItem(item, status)
	case inference.OutputItemReasoning:
		return marshalReasoningItem(item, status)
	case inference.OutputItemToolCall:
		return marshalFunctionCallItem(item, status)
	default:
		return nil, ErrUnsupportedResponseEvent
	}
}

// marshalMessageItem 编码文本或 refusal 消息内容。
func marshalMessageItem(item *outputItemState, status string) (json.RawMessage, error) {
	contents := make([]json.RawMessage, len(item.blocks))
	for index, block := range item.blocks {
		encoded, err := marshalMessagePart(block)
		if err != nil {
			return nil, err
		}
		contents[index] = encoded
	}
	return json.Marshal(messageItemWireDTO{
		ID:      item.id,
		Type:    "message",
		Status:  status,
		Role:    "assistant",
		Content: contents,
		Phase:   string(item.phase),
	})
}

// marshalMessagePart 编码一个 Responses message 内容块。
func marshalMessagePart(block *contentBlockState) (json.RawMessage, error) {
	switch block.kind {
	case inference.ContentText:
		return json.Marshal(outputTextWireDTO{
			Type:        "output_text",
			Text:        block.text,
			Annotations: []json.RawMessage{},
		})
	case inference.ContentRefusal:
		return json.Marshal(refusalWireDTO{
			Type:    "refusal",
			Refusal: block.text,
		})
	default:
		return nil, ErrUnsupportedResponseEvent
	}
}

// marshalReasoningItem 编码 reasoning 摘要、状态和加密连续性。
func marshalReasoningItem(item *outputItemState, status string) (json.RawMessage, error) {
	summaries := make([]reasoningSummaryWireDTO, 0, len(item.blocks))
	for _, block := range item.blocks {
		if block.signature != "" {
			return nil, ErrUnsupportedResponseEvent
		}
		switch block.reasoningKind {
		case inference.ReasoningSummary, inference.ReasoningThinking:
			summaries = append(summaries, reasoningSummaryWireDTO{
				Type: "summary_text",
				Text: block.text,
			})
		case inference.ReasoningEncrypted:
		case "":
			if status != "in_progress" {
				return nil, ErrInvalidEventSequence
			}
		default:
			return nil, ErrUnsupportedResponseEvent
		}
	}
	return json.Marshal(reasoningItemWireDTO{
		ID:               item.id,
		Type:             "reasoning",
		Status:           status,
		Summary:          summaries,
		EncryptedContent: item.encryptedContent,
	})
}

// marshalFunctionCallItem 编码完整或当前累计函数调用。
func marshalFunctionCallItem(item *outputItemState, status string) (json.RawMessage, error) {
	if !item.toolCallStarted {
		return nil, ErrInvalidEventSequence
	}
	return json.Marshal(functionCallItemWireDTO{
		ID:        item.id,
		Type:      "function_call",
		Status:    status,
		CallID:    item.callID,
		Name:      item.toolName,
		Arguments: item.toolArguments,
	})
}

// newUsageWire 将 Canonical usage 转换为 Responses token 明细。
func newUsageWire(usage inference.Usage) usageWireDTO {
	return usageWireDTO{
		InputTokens: usage.InputTokens(),
		InputTokensDetails: inputTokenDetailsWireDTO{
			CachedTokens:     usage.CachedInputTokens(),
			CacheWriteTokens: usage.CacheWriteInputTokens(),
		},
		OutputTokens: usage.OutputTokens(),
		OutputTokensDetails: outputTokenDetailsWireDTO{
			ReasoningTokens: usage.ReasoningTokens(),
		},
		TotalTokens: usage.TotalTokens(),
	}
}

// optionalUint64 返回非零 uint64 的独立指针。
func optionalUint64(value uint64) *uint64 {
	if value == 0 {
		return nil
	}
	return &value
}

// optionalParallelToolCalls 返回请求中的可选并行工具意图。
func optionalParallelToolCalls(request inference.Request) *bool {
	value, found := request.ParallelToolCalls()
	if !found {
		return nil
	}
	return &value
}

// previousResponseID 只返回 Responses previous_response continuation。
func previousResponseID(request inference.Request) *string {
	continuation, found := request.Continuation()
	if !found || continuation.Kind() != inference.ContinuationPreviousResponse {
		return nil
	}
	value := continuation.ID()
	return &value
}

// optionalStore 返回请求中的可选响应存储意图。
func optionalStore(request inference.Request) *bool {
	value, found := request.Store()
	if !found {
		return nil
	}
	return &value
}

// optionalTemperature 返回请求中的可选采样温度。
func optionalTemperature(request inference.Request) *float64 {
	value, found := request.Temperature()
	if !found {
		return nil
	}
	return &value
}

// optionalTopP 返回请求中的可选 nucleus sampling 概率。
func optionalTopP(request inference.Request) *float64 {
	value, found := request.TopP()
	if !found {
		return nil
	}
	return &value
}

// optionalTruncation 返回请求中的可选截断策略。
func optionalTruncation(request inference.Request) *string {
	value, found := request.Truncation()
	if !found {
		return nil
	}
	wireValue := string(value)
	return &wireValue
}
