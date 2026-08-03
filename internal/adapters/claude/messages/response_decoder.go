package messages

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"unicode/utf8"

	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/core/inference"
)

// responseDecoder 把一个 Claude Message 生命周期转换为 Canonical 事件。
type responseDecoder struct {
	emit            inferencegateway.EventSink
	effectiveModel  string
	responseID      string
	nextSequence    uint64
	nextOutputIndex uint32
	started         bool
	terminal        bool
	blocks          []*decodedBlock
	usage           usageState
	stopReason      inference.StopReason
	stopSequence    string
	stopObserved    bool
	toolNames       toolNameMapper
}

// decodedBlock 保存一个 Anthropic 内容块及其 Canonical 输出项状态。
type decodedBlock struct {
	wireIndex       uint32
	outputIndex     uint32
	itemID          string
	wireType        string
	completed       bool
	text            string
	signature       string
	data            string
	callID          string
	identity        inference.ToolIdentity
	arguments       string
	emitsOutput     bool
	hasSearchResult bool
}

// newResponseDecoder 创建只依赖事件输出端口的响应状态机。
func newResponseDecoder(
	effectiveModel string,
	emit inferencegateway.EventSink,
	toolMappings ...toolNameMapper,
) (*responseDecoder, error) {
	if effectiveModel == "" || emit == nil || len(toolMappings) > 1 {
		return nil, ErrInvalidDependencies
	}
	var toolNames toolNameMapper
	if len(toolMappings) == 1 {
		toolNames = toolMappings[0]
	}
	return &responseDecoder{
		emit:           emit,
		effectiveModel: effectiveModel,
		toolNames:      toolNames,
	}, nil
}

// Apply 校验并应用一个已经完成网络分块重组的 Claude SSE 事件。
func (decoder *responseDecoder) Apply(
	sseEventType string,
	data []byte,
) error {
	if decoder == nil || decoder.terminal || len(data) == 0 {
		return ErrInvalidUpstreamResponse
	}
	var event streamEventDTO
	if err := json.Unmarshal(data, &event); err != nil ||
		event.Type == "" ||
		sseEventType != "" && sseEventType != event.Type {
		return ErrInvalidUpstreamResponse
	}
	switch event.Type {
	case "ping":
		return nil
	case "message_start":
		return decoder.startMessage(event.Message)
	case "content_block_start":
		return decoder.startContentBlock(event.Index, event.ContentBlock)
	case "content_block_delta":
		return decoder.applyContentDelta(event.Index, event.Delta)
	case "content_block_stop":
		return decoder.completeContentBlock(event.Index)
	case "message_delta":
		return decoder.applyMessageDelta(event.Delta, event.Usage)
	case "message_stop":
		return decoder.completeMessage()
	default:
		return ErrInvalidUpstreamResponse
	}
}

// DecodeMessage 解码第三方兼容端点返回的完整非流式 Message。
func (decoder *responseDecoder) DecodeMessage(data []byte) error {
	if decoder == nil || decoder.started || decoder.terminal || len(data) == 0 {
		return ErrInvalidUpstreamResponse
	}
	var message messageResponseDTO
	if err := json.Unmarshal(data, &message); err != nil {
		return ErrInvalidUpstreamResponse
	}
	content := message.Content
	usage := message.Usage
	message.Content = nil
	message.Usage = nil
	startPayload, err := json.Marshal(message)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.startMessage(startPayload); err != nil {
		return err
	}
	for index, raw := range content {
		if err := decoder.decodeCompletedBlock(uint32(index), raw); err != nil {
			return err
		}
	}
	if err := decoder.updateUsage(usage); err != nil {
		return err
	}
	if message.StopReason == nil {
		return ErrInvalidUpstreamResponse
	}
	stopSequence := ""
	if message.StopSequence != nil {
		stopSequence = *message.StopSequence
	}
	stopReason, err := decodeStopReason(*message.StopReason, stopSequence)
	if err != nil {
		return err
	}
	decoder.stopReason = stopReason
	decoder.stopSequence = stopSequence
	decoder.stopObserved = true
	return decoder.completeMessage()
}

// Terminal 表示 Decoder 已收到明确 message_stop。
func (decoder *responseDecoder) Terminal() bool {
	return decoder != nil && decoder.terminal
}

// startMessage 固定响应身份并接收初始输入 usage。
func (decoder *responseDecoder) startMessage(
	raw json.RawMessage,
) error {
	if decoder.started || len(raw) == 0 {
		return ErrInvalidUpstreamResponse
	}
	var message messageResponseDTO
	if err := json.Unmarshal(raw, &message); err != nil ||
		message.ID == "" ||
		message.Type != "message" ||
		message.Role != "assistant" ||
		len(message.Content) != 0 {
		return ErrInvalidUpstreamResponse
	}
	model := message.Model
	if model == "" {
		model = decoder.effectiveModel
	}
	event, err := inference.NewResponseStartedEvent(
		decoder.nextSequence,
		message.ID,
		model,
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.emitEvent(event); err != nil {
		return err
	}
	decoder.responseID = message.ID
	decoder.started = true
	return decoder.updateUsage(message.Usage)
}

// startContentBlock 创建与 Anthropic 扁平内容索引对应的 Canonical 输出项。
func (decoder *responseDecoder) startContentBlock(
	index *uint32,
	raw json.RawMessage,
) error {
	if !decoder.started ||
		index == nil ||
		int(*index) != len(decoder.blocks) ||
		len(raw) == 0 ||
		decoder.hasOpenBlock() {
		return ErrInvalidUpstreamResponse
	}
	var wire outputContentDTO
	if err := json.Unmarshal(raw, &wire); err != nil || wire.Type == "" {
		return ErrInvalidUpstreamResponse
	}
	block := &decodedBlock{
		wireIndex: *index,
		wireType:  wire.Type,
	}
	switch wire.Type {
	case "text":
		decoder.assignOutput(block, wire.Type)
		if err := decoder.startValueBlock(
			block,
			inference.OutputItemMessage,
			inference.ContentText,
		); err != nil {
			return err
		}
		if wire.Text != "" {
			if err := decoder.appendText(block, wire.Text); err != nil {
				return err
			}
		}
		if err := decoder.appendInitialCitations(block, wire.Citations); err != nil {
			return err
		}
	case "thinking":
		decoder.assignOutput(block, wire.Type)
		if err := decoder.startValueBlock(
			block,
			inference.OutputItemReasoning,
			inference.ContentReasoning,
		); err != nil {
			return err
		}
		if wire.Thinking != "" {
			if err := decoder.appendThinking(block, wire.Thinking); err != nil {
				return err
			}
		}
		if wire.Signature != "" {
			if err := decoder.appendSignature(block, wire.Signature); err != nil {
				return err
			}
		}
	case "redacted_thinking":
		if wire.Data == "" {
			return ErrInvalidUpstreamResponse
		}
		decoder.assignOutput(block, wire.Type)
		if err := decoder.startValueBlock(
			block,
			inference.OutputItemReasoning,
			inference.ContentReasoning,
		); err != nil {
			return err
		}
		block.data = wire.Data
	case "tool_use":
		if wire.ID == "" || wire.Name == "" ||
			!isEmptyJSONObject(wire.Input) {
			return ErrInvalidUpstreamResponse
		}
		identity, err := decoder.toolNames.decode(wire.Name)
		if err != nil {
			return err
		}
		block.itemID = wire.ID
		block.callID = wire.ID
		block.identity = identity
		decoder.assignOutput(block, wire.Type)
		block.itemID = wire.ID
		if err := decoder.startToolBlock(block); err != nil {
			return err
		}
	case "server_tool_use":
		if wire.ID == "" || wire.Name != "web_search" ||
			!isEmptyJSONObject(wire.Input) {
			return ErrInvalidUpstreamResponse
		}
		decoder.assignOutput(block, wire.Type)
		block.itemID = wire.ID
		block.callID = wire.ID
		if err := decoder.startWebSearchBlock(block); err != nil {
			return err
		}
	case "web_search_tool_result":
		if wire.ToolUseID == "" || len(wire.Content) == 0 ||
			!json.Valid(wire.Content) ||
			decoder.bindWebSearchResult(wire.ToolUseID, wire.Content) != nil {
			return ErrInvalidUpstreamResponse
		}
		block.callID = wire.ToolUseID
	default:
		return ErrInvalidUpstreamResponse
	}
	decoder.blocks = append(decoder.blocks, block)
	return nil
}

// assignOutput 为会向客户端暴露的 Claude 内容块分配连续输出索引。
func (decoder *responseDecoder) assignOutput(block *decodedBlock, wireType string) {
	block.outputIndex = decoder.nextOutputIndex
	block.emitsOutput = true
	block.itemID = canonicalItemID(decoder.responseID, block.outputIndex, wireType)
	decoder.nextOutputIndex++
}

// startValueBlock 提交消息或 reasoning 输出项及其唯一内容块。
func (decoder *responseDecoder) startValueBlock(
	block *decodedBlock,
	itemKind inference.OutputItemKind,
	contentKind inference.ContentKind,
) error {
	item, err := inference.NewOutputItemStartedEvent(
		decoder.nextSequence,
		block.outputIndex,
		block.itemID,
		itemKind,
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.emitEvent(item); err != nil {
		return err
	}
	content, err := inference.NewContentBlockStartedEvent(
		decoder.nextSequence,
		block.outputIndex,
		0,
		contentKind,
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	return decoder.emitEvent(content)
}

// startToolBlock 提交工具输出项和调用身份。
func (decoder *responseDecoder) startToolBlock(
	block *decodedBlock,
) error {
	item, err := inference.NewOutputItemStartedEvent(
		decoder.nextSequence,
		block.outputIndex,
		block.itemID,
		inference.OutputItemToolCall,
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.emitEvent(item); err != nil {
		return err
	}
	started, err := newCanonicalToolCallStartedEvent(
		decoder.nextSequence,
		block.outputIndex,
		block.callID,
		block.identity,
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	return decoder.emitEvent(started)
}

// startWebSearchBlock 提交服务器侧搜索输出项开始事件。
func (decoder *responseDecoder) startWebSearchBlock(block *decodedBlock) error {
	item, err := inference.NewOutputItemStartedEvent(
		decoder.nextSequence,
		block.outputIndex,
		block.itemID,
		inference.OutputItemWebSearch,
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	return decoder.emitEvent(item)
}

// applyContentDelta 将增量交给当前唯一开放内容块。
func (decoder *responseDecoder) applyContentDelta(
	index *uint32,
	raw json.RawMessage,
) error {
	block, err := decoder.openBlock(index)
	if err != nil || len(raw) == 0 {
		return ErrInvalidUpstreamResponse
	}
	var delta contentDeltaDTO
	if json.Unmarshal(raw, &delta) != nil || delta.Type == "" {
		return ErrInvalidUpstreamResponse
	}
	switch delta.Type {
	case "text_delta":
		if block.wireType != "text" {
			return ErrInvalidUpstreamResponse
		}
		return decoder.appendText(block, delta.Text)
	case "thinking_delta":
		if block.wireType != "thinking" {
			return ErrInvalidUpstreamResponse
		}
		return decoder.appendThinking(block, delta.Thinking)
	case "signature_delta":
		if block.wireType != "thinking" {
			return ErrInvalidUpstreamResponse
		}
		return decoder.appendSignature(block, delta.Signature)
	case "input_json_delta":
		if block.wireType != "tool_use" && block.wireType != "server_tool_use" {
			return ErrInvalidUpstreamResponse
		}
		if block.wireType == "server_tool_use" {
			return decoder.appendWebSearchArguments(block, delta.PartialJSON)
		}
		return decoder.appendToolArguments(block, delta.PartialJSON)
	case "citations_delta":
		if block.wireType != "text" || len(delta.Citation) == 0 {
			return ErrInvalidUpstreamResponse
		}
		return decoder.appendWebSearchCitation(block, delta.Citation)
	default:
		return ErrInvalidUpstreamResponse
	}
}

// appendText 累计并提交普通文本增量。
func (decoder *responseDecoder) appendText(
	block *decodedBlock,
	value string,
) error {
	if value == "" {
		return nil
	}
	event, err := inference.NewTextDeltaEvent(
		decoder.nextSequence,
		block.outputIndex,
		0,
		value,
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.emitEvent(event); err != nil {
		return err
	}
	block.text += value
	return nil
}

// appendThinking 累计并提交 thinking 文本。
func (decoder *responseDecoder) appendThinking(
	block *decodedBlock,
	value string,
) error {
	return decoder.appendReasoning(block, inference.ReasoningDeltaThinking, value)
}

// appendSignature 累计并提交 thinking 签名。
func (decoder *responseDecoder) appendSignature(
	block *decodedBlock,
	value string,
) error {
	return decoder.appendReasoning(block, inference.ReasoningDeltaSignature, value)
}

// appendReasoning 累计并提交指定 reasoning 增量。
func (decoder *responseDecoder) appendReasoning(
	block *decodedBlock,
	kind inference.ReasoningDeltaKind,
	value string,
) error {
	if value == "" {
		return ErrInvalidUpstreamResponse
	}
	event, err := inference.NewReasoningDeltaEvent(
		decoder.nextSequence,
		block.outputIndex,
		0,
		kind,
		value,
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.emitEvent(event); err != nil {
		return err
	}
	if kind == inference.ReasoningDeltaThinking {
		block.text += value
	} else {
		block.signature += value
	}
	return nil
}

// appendToolArguments 累计并提交原始 JSON 参数片段。
func (decoder *responseDecoder) appendToolArguments(
	block *decodedBlock,
	value string,
) error {
	if value == "" {
		// Claude Code 对每个 input_json_delta 直接做字符串拼接；真实上游
		// 允许发送空分片。空分片不改变参数，也不应伪造 Canonical 增量事件。
		return nil
	}
	event, err := inference.NewToolArgumentsDeltaEvent(
		decoder.nextSequence,
		block.outputIndex,
		0,
		block.callID,
		value,
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.emitEvent(event); err != nil {
		return err
	}
	block.arguments += value
	return nil
}

// appendWebSearchArguments 只在 Decoder 内累计服务器工具参数。
func (decoder *responseDecoder) appendWebSearchArguments(
	block *decodedBlock,
	value string,
) error {
	if value == "" {
		return nil
	}
	block.arguments += value
	return nil
}

// appendInitialCitations 解码完整 Message 文本块中已有的引用数组。
func (decoder *responseDecoder) appendInitialCitations(
	block *decodedBlock,
	raw json.RawMessage,
) error {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil
	}
	var citations []json.RawMessage
	if err := json.Unmarshal(raw, &citations); err != nil {
		return ErrInvalidUpstreamResponse
	}
	for _, citation := range citations {
		if err := decoder.appendWebSearchCitation(block, citation); err != nil {
			return err
		}
	}
	return nil
}

// appendWebSearchCitation 把 Claude 无区间引用锚定在当前文本末尾。
// Claude 不提供输出字符区间，因此使用零宽锚点保留 URL 与标题而不伪造文本范围。
func (decoder *responseDecoder) appendWebSearchCitation(
	block *decodedBlock,
	raw json.RawMessage,
) error {
	var wire webSearchCitationDTO
	jsonDecoder := json.NewDecoder(bytes.NewReader(raw))
	jsonDecoder.DisallowUnknownFields()
	if err := jsonDecoder.Decode(&wire); err != nil ||
		jsonDecoder.Decode(&struct{}{}) != io.EOF ||
		wire.Type != "web_search_result_location" ||
		wire.CitedText == "" || wire.EncryptedIndex == "" {
		return ErrInvalidUpstreamResponse
	}
	title := ""
	if wire.Title != nil {
		title = *wire.Title
	}
	anchor := uint32(utf8.RuneCountInString(block.text))
	citation, err := inference.NewURLCitation(anchor, anchor, title, wire.URL)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	event, err := inference.NewURLCitationAddedEvent(
		decoder.nextSequence,
		block.outputIndex,
		0,
		citation,
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	return decoder.emitEvent(event)
}

// completeContentBlock 生成内容终值、块终态和输出项终态。
func (decoder *responseDecoder) completeContentBlock(
	index *uint32,
) error {
	block, err := decoder.openBlock(index)
	if err != nil {
		return err
	}
	switch block.wireType {
	case "text":
		if err := decoder.completeText(block); err != nil {
			return err
		}
	case "thinking":
		if err := decoder.completeThinking(block); err != nil {
			return err
		}
	case "redacted_thinking":
		if err := decoder.completeRedactedThinking(block); err != nil {
			return err
		}
	case "tool_use":
		if err := decoder.completeTool(block); err != nil {
			return err
		}
	case "server_tool_use":
		if err := decoder.completeWebSearch(block); err != nil {
			return err
		}
	case "web_search_tool_result":
		block.completed = true
		return nil
	default:
		return ErrInvalidUpstreamResponse
	}
	block.completed = true
	return decoder.completeOutputItem(block)
}

// completeWebSearch 解析 Claude 搜索参数并提交可被 Responses 渲染的动作。
func (decoder *responseDecoder) completeWebSearch(block *decodedBlock) error {
	if block.arguments == "" {
		return ErrInvalidUpstreamResponse
	}
	var input struct {
		Query string `json:"query"`
	}
	jsonDecoder := json.NewDecoder(bytes.NewReader([]byte(block.arguments)))
	jsonDecoder.DisallowUnknownFields()
	if err := jsonDecoder.Decode(&input); err != nil ||
		jsonDecoder.Decode(&struct{}{}) != io.EOF {
		return ErrInvalidUpstreamResponse
	}
	event, err := inference.NewWebSearchCompletedEvent(
		decoder.nextSequence,
		block.outputIndex,
		input.Query,
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	return decoder.emitEvent(event)
}

// completeText 提交完整文本和内容块终态。
func (decoder *responseDecoder) completeText(block *decodedBlock) error {
	event, err := inference.NewTextCompletedEvent(
		decoder.nextSequence,
		block.outputIndex,
		0,
		block.text,
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.emitEvent(event); err != nil {
		return err
	}
	return decoder.completeCanonicalContentBlock(block)
}

// completeThinking 要求 thinking 文本和签名均完整。
func (decoder *responseDecoder) completeThinking(
	block *decodedBlock,
) error {
	content, err := inference.NewThinkingContent(
		block.text,
		block.signature,
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	event, err := inference.NewReasoningCompletedEvent(
		decoder.nextSequence,
		block.outputIndex,
		0,
		content,
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.emitEvent(event); err != nil {
		return err
	}
	return decoder.completeCanonicalContentBlock(block)
}

// completeRedactedThinking 提交不可读连续性原值。
func (decoder *responseDecoder) completeRedactedThinking(
	block *decodedBlock,
) error {
	content, err := inference.NewRedactedReasoningContent(block.data)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	event, err := inference.NewReasoningCompletedEvent(
		decoder.nextSequence,
		block.outputIndex,
		0,
		content,
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.emitEvent(event); err != nil {
		return err
	}
	return decoder.completeCanonicalContentBlock(block)
}

// completeTool 校验聚合参数是完整 JSON Object。
func (decoder *responseDecoder) completeTool(
	block *decodedBlock,
) error {
	if block.arguments == "" {
		block.arguments = "{}"
	}
	event, err := newCanonicalToolCallCompletedEvent(
		decoder.nextSequence,
		block.outputIndex,
		block.callID,
		block.identity,
		[]byte(block.arguments),
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	return decoder.emitEvent(event)
}

// newCanonicalToolCallStartedEvent 根据完整身份选择普通或 namespaced 构造器。
func newCanonicalToolCallStartedEvent(
	sequence uint64,
	outputIndex uint32,
	callID string,
	identity inference.ToolIdentity,
) (inference.ToolCallStartedEvent, error) {
	if namespace, namespaced := identity.Namespace(); namespaced {
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

// newCanonicalToolCallCompletedEvent 根据完整身份创建工具完成事件。
func newCanonicalToolCallCompletedEvent(
	sequence uint64,
	outputIndex uint32,
	callID string,
	identity inference.ToolIdentity,
	arguments []byte,
) (inference.ToolCallCompletedEvent, error) {
	if namespace, namespaced := identity.Namespace(); namespaced {
		return inference.NewNamespacedToolCallCompletedEvent(
			sequence,
			outputIndex,
			0,
			callID,
			namespace,
			identity.Name(),
			arguments,
		)
	}
	return inference.NewToolCallCompletedEvent(
		sequence,
		outputIndex,
		0,
		callID,
		identity.Name(),
		arguments,
	)
}

// completeCanonicalContentBlock 提交普通或 reasoning 块结束。
func (decoder *responseDecoder) completeCanonicalContentBlock(
	block *decodedBlock,
) error {
	event := inference.NewContentBlockCompletedEvent(
		decoder.nextSequence,
		block.outputIndex,
		0,
	)
	return decoder.emitEvent(event)
}

// completeOutputItem 提交当前输出项结束。
func (decoder *responseDecoder) completeOutputItem(
	block *decodedBlock,
) error {
	event, err := inference.NewOutputItemCompletedEvent(
		decoder.nextSequence,
		block.outputIndex,
		block.itemID,
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	return decoder.emitEvent(event)
}

// bindWebSearchResult 校验隐藏结果并与唯一已完成搜索调用配对。
func (decoder *responseDecoder) bindWebSearchResult(
	callID string,
	raw json.RawMessage,
) error {
	if err := validateWebSearchResult(raw); err != nil {
		return err
	}
	for _, block := range decoder.blocks {
		if block.wireType == "server_tool_use" &&
			block.callID == callID &&
			block.completed &&
			!block.hasSearchResult {
			block.hasSearchResult = true
			return nil
		}
	}
	return ErrInvalidUpstreamResponse
}

// validateWebSearchResult 接受结果数组或 Anthropic 明确的搜索错误对象。
func validateWebSearchResult(raw json.RawMessage) error {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return ErrInvalidUpstreamResponse
	}
	if trimmed[0] == '[' {
		var results []webSearchResultDTO
		if err := json.Unmarshal(trimmed, &results); err != nil {
			return ErrInvalidUpstreamResponse
		}
		for _, result := range results {
			if result.Type != "web_search_result" ||
				result.EncryptedContent == "" || result.Title == "" {
				return ErrInvalidUpstreamResponse
			}
			if _, err := inference.NewURLCitation(
				0,
				0,
				result.Title,
				result.URL,
			); err != nil {
				return ErrInvalidUpstreamResponse
			}
		}
		return nil
	}
	var resultError webSearchResultErrorDTO
	jsonDecoder := json.NewDecoder(bytes.NewReader(trimmed))
	jsonDecoder.DisallowUnknownFields()
	if err := jsonDecoder.Decode(&resultError); err != nil ||
		jsonDecoder.Decode(&struct{}{}) != io.EOF ||
		resultError.Type != "web_search_tool_result_error" ||
		!isWebSearchResultErrorCode(resultError.ErrorCode) {
		return ErrInvalidUpstreamResponse
	}
	return nil
}

// isWebSearchResultErrorCode 只接受 Anthropic 公开的搜索失败枚举。
func isWebSearchResultErrorCode(value string) bool {
	switch value {
	case "invalid_tool_input", "unavailable", "max_uses_exceeded",
		"too_many_requests", "query_too_long", "request_too_large":
		return true
	default:
		return false
	}
}

// applyMessageDelta 合并最终 usage 和停止原因。
func (decoder *responseDecoder) applyMessageDelta(
	rawDelta json.RawMessage,
	rawUsage json.RawMessage,
) error {
	if !decoder.started || decoder.stopObserved || len(rawDelta) == 0 {
		return ErrInvalidUpstreamResponse
	}
	var delta messageDeltaDTO
	if err := json.Unmarshal(rawDelta, &delta); err != nil ||
		delta.StopReason == "" {
		return ErrInvalidUpstreamResponse
	}
	stopSequence := ""
	if delta.StopSequence != nil {
		stopSequence = *delta.StopSequence
	}
	stopReason, err := decodeStopReason(delta.StopReason, stopSequence)
	if err != nil {
		return err
	}
	if err := decoder.updateUsage(rawUsage); err != nil {
		return err
	}
	decoder.stopReason = stopReason
	decoder.stopSequence = stopSequence
	decoder.stopObserved = true
	return nil
}

// completeMessage 只在所有内容块和停止原因完整时提交成功终态。
func (decoder *responseDecoder) completeMessage() error {
	if !decoder.started ||
		!decoder.stopObserved ||
		decoder.hasOpenBlock() {
		return ErrInvalidUpstreamResponse
	}
	for _, block := range decoder.blocks {
		if !block.completed ||
			block.wireType == "server_tool_use" && !block.hasSearchResult {
			return ErrInvalidUpstreamResponse
		}
	}
	usage, err := decoder.usage.canonical()
	if err != nil {
		return err
	}
	event, err := inference.NewResponseCompletedEvent(
		decoder.nextSequence,
		decoder.stopReason,
		decoder.stopSequence,
		usage,
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.emitEvent(event); err != nil {
		return err
	}
	decoder.terminal = true
	return nil
}

// decodeCompletedBlock 让非流式 Message 复用同一状态推进方法。
func (decoder *responseDecoder) decodeCompletedBlock(
	index uint32,
	raw json.RawMessage,
) error {
	var wire outputContentDTO
	if err := json.Unmarshal(raw, &wire); err != nil {
		return ErrInvalidUpstreamResponse
	}
	startWire := wire
	switch wire.Type {
	case "text":
		startWire.Text = ""
		startWire.Citations = nil
	case "thinking":
		startWire.Thinking = ""
		startWire.Signature = ""
	case "tool_use":
		startWire.Input = json.RawMessage(`{}`)
	case "server_tool_use":
		startWire.Input = json.RawMessage(`{}`)
	}
	startRaw, err := json.Marshal(startWire)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.startContentBlock(&index, startRaw); err != nil {
		return err
	}
	block := decoder.blocks[index]
	switch wire.Type {
	case "text":
		if err := decoder.appendText(block, wire.Text); err != nil {
			return err
		}
		if err := decoder.appendInitialCitations(block, wire.Citations); err != nil {
			return err
		}
	case "thinking":
		if err := decoder.appendThinking(block, wire.Thinking); err != nil {
			return err
		}
		if err := decoder.appendSignature(block, wire.Signature); err != nil {
			return err
		}
	case "redacted_thinking":
		block.data = wire.Data
	case "tool_use":
		arguments := string(wire.Input)
		if arguments == "" {
			arguments = "{}"
		}
		if err := decoder.appendToolArguments(block, arguments); err != nil {
			return err
		}
	case "server_tool_use":
		arguments := string(wire.Input)
		if err := decoder.appendWebSearchArguments(block, arguments); err != nil {
			return err
		}
	case "web_search_tool_result":
	default:
		return ErrInvalidUpstreamResponse
	}
	return decoder.completeContentBlock(&index)
}

// openBlock 返回索引匹配且尚未结束的块。
func (decoder *responseDecoder) openBlock(
	index *uint32,
) (*decodedBlock, error) {
	if !decoder.started ||
		index == nil ||
		int(*index) >= len(decoder.blocks) {
		return nil, ErrInvalidUpstreamResponse
	}
	block := decoder.blocks[*index]
	if block.completed || block.wireIndex != *index {
		return nil, ErrInvalidUpstreamResponse
	}
	return block, nil
}

// hasOpenBlock 判断最后一个 Anthropic 内容块是否仍在生成。
func (decoder *responseDecoder) hasOpenBlock() bool {
	return len(decoder.blocks) > 0 &&
		!decoder.blocks[len(decoder.blocks)-1].completed
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

// canonicalItemID 为没有独立上游 ID 的内容块创建稳定低敏身份。
func canonicalItemID(
	responseID string,
	outputIndex uint32,
	wireType string,
) string {
	digest := sha256.Sum256([]byte(fmt.Sprintf(
		"%s:%d:%s",
		responseID,
		outputIndex,
		wireType,
	)))
	return "claude_item_" + hex.EncodeToString(digest[:8])
}

// decodeStopReason 把 Anthropic 停止原因映射为 Canonical 分类。
func decodeStopReason(
	value string,
	stopSequence string,
) (inference.StopReason, error) {
	switch value {
	case "end_turn":
		if stopSequence != "" {
			return "", ErrInvalidUpstreamResponse
		}
		return inference.StopReasonEndTurn, nil
	case "stop_sequence":
		if stopSequence == "" {
			return "", ErrInvalidUpstreamResponse
		}
		return inference.StopReasonStopSequence, nil
	case "max_tokens", "model_context_window_exceeded":
		if stopSequence != "" {
			return "", ErrInvalidUpstreamResponse
		}
		return inference.StopReasonMaxTokens, nil
	case "tool_use":
		if stopSequence != "" {
			return "", ErrInvalidUpstreamResponse
		}
		return inference.StopReasonToolUse, nil
	case "pause_turn":
		if stopSequence != "" {
			return "", ErrInvalidUpstreamResponse
		}
		return inference.StopReasonPauseTurn, nil
	case "refusal":
		if stopSequence != "" {
			return "", ErrInvalidUpstreamResponse
		}
		return inference.StopReasonContentFilter, nil
	default:
		return "", ErrInvalidUpstreamResponse
	}
}

// isEmptyJSONObject 判断工具 start 快照是否是空 Object。
func isEmptyJSONObject(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	var value map[string]json.RawMessage
	return json.Unmarshal(raw, &value) == nil && len(value) == 0
}

// checkedAddUsage 防止上游 token 分项求和溢出。
func checkedAddUsage(values ...uint64) (uint64, error) {
	var total uint64
	for _, value := range values {
		if value > math.MaxUint64-total {
			return 0, ErrInvalidUpstreamResponse
		}
		total += value
	}
	return total, nil
}
