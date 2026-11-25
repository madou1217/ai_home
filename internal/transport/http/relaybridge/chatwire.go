// Package relaybridge 让只支持 OpenAI Chat 线协议的透传 Provider（kiro / cline /
// grok / kimi / opencode / qoder / 家族与插件 Provider）也能服务 Anthropic Messages
// 与 OpenAI Responses 两个客户端入口。
//
// 设计边界：
//   - 上游线协议始终是 OpenAI Chat：relaycore 的 Provider 差异面、账号调度、鉴权、
//     429 重试与用量记账全部原样复用，本包不改写它们。
//   - 客户端协议由本包转换为 Chat 请求，并把 Chat 响应/事件流渲染回客户端协议。
//     渲染复用 internal/adapters/clientprotocol 已验收的 Renderer/Aggregator，
//     本包只负责把 Chat 线协议解码成 Canonical 事件。
//   - 只有 Canonical 目录没有路由的模型（relay-only）才进入桥；有 Canonical 路由的
//     模型仍走原有入口，避免改变 claude/codex 等原生通道的字段保真行为。
package relaybridge

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/core/inference"
)

// chatWire 是 OpenAI Chat Completions 的增量或非流式响应。
//
// 只解析桥关心的字段：文本、推理、工具调用、结束原因与用量。未知字段不参与决策。
type chatWire struct {
	ID      string          `json:"id"`
	Model   string          `json:"model"`
	Choices []chatChoice    `json:"choices"`
	Usage   *chatUsage      `json:"usage"`
	Error   json.RawMessage `json:"error"`
}

type chatChoice struct {
	Index        int         `json:"index"`
	Delta        chatMessage `json:"delta"`
	Message      chatMessage `json:"message"`
	FinishReason *string     `json:"finish_reason"`
}

type chatMessage struct {
	Content          chatContent       `json:"content"`
	ReasoningContent string            `json:"reasoning_content"`
	Reasoning        string            `json:"reasoning"`
	Refusal          string            `json:"refusal"`
	ToolCalls        []chatToolCall    `json:"tool_calls"`
	FunctionCall     *chatToolFunction `json:"function_call"`
}

// chatContent 兼容 Chat 上游的两种 content 形态：字符串或内容数组。
//
// 多数 OpenAI 兼容上游返回字符串；个别上游（本地推理网关、vLLM 变体）会回
// [{type:"text",text:"…"}]。只认一种会把整条响应判成无法解析。
type chatContent struct {
	text string
}

func (content *chatContent) UnmarshalJSON(raw []byte) error {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		content.text = ""
		return nil
	}
	if trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return err
		}
		content.text = text
		return nil
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(trimmed, &parts); err != nil {
		return err
	}
	var builder strings.Builder
	for _, part := range parts {
		if part.Text != "" {
			builder.WriteString(part.Text)
		}
	}
	content.text = builder.String()
	return nil
}

func (content chatContent) String() string { return content.text }

type chatToolCall struct {
	Index    *int             `json:"index"`
	ID       string           `json:"id"`
	Type     string           `json:"type"`
	Function chatToolFunction `json:"function"`
}

type chatToolFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type chatUsage struct {
	PromptTokens            int               `json:"prompt_tokens"`
	CompletionTokens        int               `json:"completion_tokens"`
	TotalTokens             int               `json:"total_tokens"`
	PromptTokensDetails     *chatTokenDetails `json:"prompt_tokens_details"`
	CompletionTokensDetails *chatTokenDetails `json:"completion_tokens_details"`
}

type chatTokenDetails struct {
	CachedTokens    int `json:"cached_tokens"`
	ReasoningTokens int `json:"reasoning_tokens"`
}

// chatEventDecoder 把 Chat 增量/终值转成严格连续的 Canonical 事件序列。
//
// 两个 Renderer（Anthropic Messages 与 OpenAI Responses）共享同一套状态机约束：
// 序号从 0 连续、输出项索引连续、内容块索引连续、终态前所有项必须完成。因此这里
// 集中生成事件，而不是在两个入口各写一遍 Chat→客户端协议的状态机。
type chatEventDecoder struct {
	responseID string
	model      string

	sequence uint64
	started  bool
	finished bool

	nextOutput uint32
	reasoning  *chatStreamItem
	text       *chatStreamItem
	refusal    *chatStreamItem
	tools      map[int]*chatStreamTool
	toolOrder  []int

	usage    inference.Usage
	usageSet bool
	anyTool  bool
}

type chatStreamItem struct {
	output    uint32
	itemID    string
	opened    bool
	completed bool
}

type chatStreamTool struct {
	index    int
	output   uint32
	itemID   string
	callID   string
	name     string
	args     strings.Builder
	opened   bool
	started  bool
	complete bool
}

func newChatEventDecoder(responseID string, model string) *chatEventDecoder {
	return &chatEventDecoder{
		responseID: strings.TrimSpace(responseID),
		model:      strings.TrimSpace(model),
		tools:      make(map[int]*chatStreamTool),
	}
}

// consumeDelta 吸收一条流式增量。
func (decoder *chatEventDecoder) consumeDelta(delta chatMessage) ([]inference.StreamEvent, error) {
	events, err := decoder.ensureStarted()
	if err != nil {
		return nil, err
	}
	reasoning := delta.ReasoningContent
	if reasoning == "" {
		reasoning = delta.Reasoning
	}
	if reasoning != "" {
		reasoningEvents, err := decoder.appendReasoning(reasoning)
		if err != nil {
			return nil, err
		}
		events = append(events, reasoningEvents...)
	}
	if text := delta.Content.String(); text != "" {
		textEvents, err := decoder.appendText(text)
		if err != nil {
			return nil, err
		}
		events = append(events, textEvents...)
	}
	if delta.Refusal != "" {
		refusalEvents, err := decoder.appendRefusal(delta.Refusal)
		if err != nil {
			return nil, err
		}
		events = append(events, refusalEvents...)
	}
	calls := delta.ToolCalls
	if len(calls) == 0 && delta.FunctionCall != nil && strings.TrimSpace(delta.FunctionCall.Name) != "" {
		calls = []chatToolCall{{ID: "call_function", Type: "function", Function: *delta.FunctionCall}}
	}
	for _, call := range calls {
		toolEvents, err := decoder.acceptToolCall(call)
		if err != nil {
			return nil, err
		}
		events = append(events, toolEvents...)
	}
	return events, nil
}

// consumeCompletion 吸收一条非流式完整响应。
func (decoder *chatEventDecoder) consumeCompletion(message chatMessage) ([]inference.StreamEvent, error) {
	events, err := decoder.ensureStarted()
	if err != nil {
		return nil, err
	}
	reasoning := message.ReasoningContent
	if reasoning == "" {
		reasoning = message.Reasoning
	}
	if reasoning != "" {
		reasoningEvents, err := decoder.appendReasoning(reasoning)
		if err != nil {
			return nil, err
		}
		events = append(events, reasoningEvents...)
	}
	if text := message.Content.String(); text != "" {
		textEvents, err := decoder.appendText(text)
		if err != nil {
			return nil, err
		}
		events = append(events, textEvents...)
	}
	if message.Refusal != "" {
		refusalEvents, err := decoder.appendRefusal(message.Refusal)
		if err != nil {
			return nil, err
		}
		events = append(events, refusalEvents...)
	}
	calls := message.ToolCalls
	if len(calls) == 0 && message.FunctionCall != nil && strings.TrimSpace(message.FunctionCall.Name) != "" {
		calls = []chatToolCall{{ID: "call_function", Type: "function", Function: *message.FunctionCall}}
	}
	for _, call := range calls {
		toolEvents, err := decoder.acceptToolCall(call)
		if err != nil {
			return nil, err
		}
		events = append(events, toolEvents...)
	}
	return events, nil
}

// applyUsage 记录增量里出现的累计用量（只保留最大快照）。
func (decoder *chatEventDecoder) applyUsage(usage *chatUsage) {
	if usage == nil {
		return
	}
	input := nonNegative(usage.PromptTokens)
	output := nonNegative(usage.CompletionTokens)
	cached := uint64(0)
	if usage.PromptTokensDetails != nil {
		cached = nonNegative(usage.PromptTokensDetails.CachedTokens)
	}
	reasoning := uint64(0)
	if usage.CompletionTokensDetails != nil {
		reasoning = nonNegative(usage.CompletionTokensDetails.ReasoningTokens)
	}
	if cached > input {
		cached = input
	}
	if reasoning > output {
		reasoning = output
	}
	next, err := inference.NewUsage(inference.UsageInput{
		InputTokens:       input,
		OutputTokens:      output,
		CachedInputTokens: cached,
		ReasoningTokens:   reasoning,
	})
	if err != nil {
		return
	}
	if !decoder.usageSet {
		decoder.usage = next
		decoder.usageSet = true
		return
	}
	decoder.usage = largerUsage(decoder.usage, next)
}

func largerUsage(left inference.Usage, right inference.Usage) inference.Usage {
	merged, err := inference.NewUsage(inference.UsageInput{
		InputTokens:           maxUint64(left.InputTokens(), right.InputTokens()),
		OutputTokens:          maxUint64(left.OutputTokens(), right.OutputTokens()),
		CachedInputTokens:     maxUint64(left.CachedInputTokens(), right.CachedInputTokens()),
		CacheWriteInputTokens: maxUint64(left.CacheWriteInputTokens(), right.CacheWriteInputTokens()),
		ReasoningTokens:       maxUint64(left.ReasoningTokens(), right.ReasoningTokens()),
	})
	if err != nil {
		return left
	}
	return merged
}

func maxUint64(left uint64, right uint64) uint64 {
	if right > left {
		return right
	}
	return left
}

func nonNegative(value int) uint64 {
	if value <= 0 {
		return 0
	}
	return uint64(value)
}

// finish 关闭仍打开的输出项并产出成功终态。
func (decoder *chatEventDecoder) finish(finishReason string) ([]inference.StreamEvent, error) {
	if decoder.finished {
		return nil, nil
	}
	events, err := decoder.ensureStarted()
	if err != nil {
		return nil, err
	}
	reasoningEvents, err := decoder.completeReasoning()
	if err != nil {
		return nil, err
	}
	events = append(events, reasoningEvents...)
	textEvents, err := decoder.completeText()
	if err != nil {
		return nil, err
	}
	events = append(events, textEvents...)
	refusalEvents, err := decoder.completeRefusal()
	if err != nil {
		return nil, err
	}
	events = append(events, refusalEvents...)
	toolEvents, err := decoder.completeTools()
	if err != nil {
		return nil, err
	}
	events = append(events, toolEvents...)
	if decoder.usageSet {
		usageEvent, err := inference.NewUsageUpdatedEvent(decoder.sequence, decoder.usage)
		if err != nil {
			return nil, err
		}
		decoder.sequence++
		events = append(events, usageEvent)
	}
	usage := decoder.usage
	if !decoder.usageSet {
		usage, err = inference.NewUsage(inference.UsageInput{})
		if err != nil {
			return nil, err
		}
	}
	reason := stopReasonForChat(finishReason)
	if strings.TrimSpace(finishReason) == "" && decoder.anyTool {
		reason = inference.StopReasonToolUse
	}
	completed, err := inference.NewResponseCompletedEvent(
		decoder.sequence,
		reason,
		"",
		usage,
	)
	if err != nil {
		return nil, err
	}
	decoder.sequence++
	decoder.finished = true
	return append(events, completed), nil
}

func (decoder *chatEventDecoder) ensureStarted() ([]inference.StreamEvent, error) {
	if decoder.started {
		return nil, nil
	}
	responseID := decoder.responseID
	if responseID == "" {
		responseID = fmt.Sprintf("chatcmpl-%d", decoder.sequence)
	}
	model := decoder.model
	if model == "" {
		model = "unknown"
	}
	started, err := inference.NewResponseStartedEvent(0, responseID, model)
	if err != nil {
		return nil, err
	}
	decoder.sequence = 1
	decoder.started = true
	return []inference.StreamEvent{started}, nil
}

func (decoder *chatEventDecoder) appendReasoning(delta string) ([]inference.StreamEvent, error) {
	var events []inference.StreamEvent
	if decoder.reasoning == nil || decoder.reasoning.completed {
		decoder.reasoning = &chatStreamItem{
			output: decoder.nextOutput,
			itemID: fmt.Sprintf("reasoning_%d", decoder.nextOutput),
		}
		decoder.nextOutput++
		item, err := inference.NewOutputItemStartedEvent(
			decoder.sequence,
			decoder.reasoning.output,
			decoder.reasoning.itemID,
			inference.OutputItemReasoning,
		)
		if err != nil {
			return nil, err
		}
		decoder.sequence++
		block, err := inference.NewContentBlockStartedEvent(
			decoder.sequence,
			decoder.reasoning.output,
			0,
			inference.ContentReasoning,
		)
		if err != nil {
			return nil, err
		}
		decoder.sequence++
		decoder.reasoning.opened = true
		events = append(events, item, block)
	}
	deltaEvent, err := inference.NewReasoningDeltaEvent(
		decoder.sequence,
		decoder.reasoning.output,
		0,
		inference.ReasoningDeltaThinking,
		delta,
	)
	if err != nil {
		return nil, err
	}
	decoder.sequence++
	return append(events, deltaEvent), nil
}

func (decoder *chatEventDecoder) appendText(delta string) ([]inference.StreamEvent, error) {
	var events []inference.StreamEvent
	// Chat 上游先输出 reasoning 再输出正文；正文开始时先关闭 thinking 块，
	// 保持 Anthropic 内容块顺序（开始/增量/结束不跨块交错）。
	reasoningEvents, err := decoder.completeReasoning()
	if err != nil {
		return nil, err
	}
	events = append(events, reasoningEvents...)
	refusalEvents, err := decoder.completeRefusal()
	if err != nil {
		return nil, err
	}
	events = append(events, refusalEvents...)
	if decoder.text == nil || decoder.text.completed {
		decoder.text = &chatStreamItem{
			output: decoder.nextOutput,
			itemID: fmt.Sprintf("message_%d", decoder.nextOutput),
		}
		decoder.nextOutput++
		item, err := inference.NewOutputItemStartedEvent(
			decoder.sequence,
			decoder.text.output,
			decoder.text.itemID,
			inference.OutputItemMessage,
		)
		if err != nil {
			return nil, err
		}
		decoder.sequence++
		block, err := inference.NewContentBlockStartedEvent(
			decoder.sequence,
			decoder.text.output,
			0,
			inference.ContentText,
		)
		if err != nil {
			return nil, err
		}
		decoder.sequence++
		decoder.text.opened = true
		events = append(events, item, block)
	}
	deltaEvent, err := inference.NewTextDeltaEvent(
		decoder.sequence,
		decoder.text.output,
		0,
		delta,
	)
	if err != nil {
		return nil, err
	}
	decoder.sequence++
	return append(events, deltaEvent), nil
}

// appendRefusal 输出独立的 refusal 内容块；Chat 的拒答与正文互斥，但两者都
// 归在同一条 assistant 消息语义下，因此单独占用一个输出项。
func (decoder *chatEventDecoder) appendRefusal(delta string) ([]inference.StreamEvent, error) {
	var events []inference.StreamEvent
	if decoder.refusal == nil || decoder.refusal.completed {
		decoder.refusal = &chatStreamItem{
			output: decoder.nextOutput,
			itemID: fmt.Sprintf("refusal_%d", decoder.nextOutput),
		}
		decoder.nextOutput++
		item, err := inference.NewOutputItemStartedEvent(
			decoder.sequence,
			decoder.refusal.output,
			decoder.refusal.itemID,
			inference.OutputItemMessage,
		)
		if err != nil {
			return nil, err
		}
		decoder.sequence++
		block, err := inference.NewContentBlockStartedEvent(
			decoder.sequence,
			decoder.refusal.output,
			0,
			inference.ContentRefusal,
		)
		if err != nil {
			return nil, err
		}
		decoder.sequence++
		decoder.refusal.opened = true
		events = append(events, item, block)
	}
	deltaEvent, err := inference.NewRefusalDeltaEvent(
		decoder.sequence,
		decoder.refusal.output,
		0,
		delta,
	)
	if err != nil {
		return nil, err
	}
	decoder.sequence++
	return append(events, deltaEvent), nil
}

func (decoder *chatEventDecoder) acceptToolCall(call chatToolCall) ([]inference.StreamEvent, error) {
	index := 0
	if call.Index != nil {
		index = *call.Index
	}
	tool, found := decoder.tools[index]
	if !found {
		tool = &chatStreamTool{index: index}
		decoder.tools[index] = tool
		decoder.toolOrder = append(decoder.toolOrder, index)
	}
	if call.ID != "" {
		tool.callID = call.ID
	}
	if call.Function.Name != "" {
		tool.name = call.Function.Name
	}
	if call.Type != "" && call.Type != "function" {
		return nil, nil
	}
	tool.args.WriteString(call.Function.Arguments)
	// 工具参数先缓冲到结束再一次性交付：Chat 的增量参数可能被切成非法 JSON 片段，
	// 直接转成 Canonical 参数增量会在完成时违反“完整参数必须是增量前缀”的约束。
	return nil, nil
}

func (decoder *chatEventDecoder) completeReasoning() ([]inference.StreamEvent, error) {
	if decoder.reasoning == nil || !decoder.reasoning.opened || decoder.reasoning.completed {
		return nil, nil
	}
	block := inference.NewContentBlockCompletedEvent(
		decoder.sequence,
		decoder.reasoning.output,
		0,
	)
	decoder.sequence++
	item, err := inference.NewOutputItemCompletedEvent(
		decoder.sequence,
		decoder.reasoning.output,
		decoder.reasoning.itemID,
	)
	if err != nil {
		return nil, err
	}
	decoder.sequence++
	decoder.reasoning.completed = true
	return []inference.StreamEvent{block, item}, nil
}

func (decoder *chatEventDecoder) completeText() ([]inference.StreamEvent, error) {
	if decoder.text == nil || !decoder.text.opened || decoder.text.completed {
		return nil, nil
	}
	block := inference.NewContentBlockCompletedEvent(
		decoder.sequence,
		decoder.text.output,
		0,
	)
	decoder.sequence++
	item, err := inference.NewOutputItemCompletedEvent(
		decoder.sequence,
		decoder.text.output,
		decoder.text.itemID,
	)
	if err != nil {
		return nil, err
	}
	decoder.sequence++
	decoder.text.completed = true
	return []inference.StreamEvent{block, item}, nil
}

func (decoder *chatEventDecoder) completeRefusal() ([]inference.StreamEvent, error) {
	if decoder.refusal == nil || !decoder.refusal.opened || decoder.refusal.completed {
		return nil, nil
	}
	block := inference.NewContentBlockCompletedEvent(
		decoder.sequence,
		decoder.refusal.output,
		0,
	)
	decoder.sequence++
	item, err := inference.NewOutputItemCompletedEvent(
		decoder.sequence,
		decoder.refusal.output,
		decoder.refusal.itemID,
	)
	if err != nil {
		return nil, err
	}
	decoder.sequence++
	decoder.refusal.completed = true
	return []inference.StreamEvent{block, item}, nil
}

func (decoder *chatEventDecoder) completeTools() ([]inference.StreamEvent, error) {
	var events []inference.StreamEvent
	for _, index := range decoder.toolOrder {
		tool := decoder.tools[index]
		if tool == nil || tool.complete || strings.TrimSpace(tool.name) == "" {
			continue
		}
		callID := strings.TrimSpace(tool.callID)
		if callID == "" {
			callID = fmt.Sprintf("call_%d", index+1)
		}
		tool.callID = callID
		tool.output = decoder.nextOutput
		tool.itemID = fmt.Sprintf("tool_%d", decoder.nextOutput)
		decoder.nextOutput++
		item, err := inference.NewOutputItemStartedEvent(
			decoder.sequence,
			tool.output,
			tool.itemID,
			inference.OutputItemToolCall,
		)
		if err != nil {
			return nil, err
		}
		decoder.sequence++
		started, err := inference.NewToolCallStartedEvent(
			decoder.sequence,
			tool.output,
			0,
			callID,
			tool.name,
		)
		if err != nil {
			return nil, err
		}
		decoder.sequence++
		events = append(events, item, started)
		// 参数只有在是合法 JSON Object 时才能成为 Canonical 工具终值；不支持时
		// 保底交付空对象，避免把整条流打断（参数增量本来就没有在流里提前暴露）。
		arguments := tool.args.String()
		if !isJSONObject(arguments) {
			arguments = "{}"
		} else {
			delta, err := inference.NewToolArgumentsDeltaEvent(
				decoder.sequence,
				tool.output,
				0,
				callID,
				arguments,
			)
			if err != nil {
				return nil, err
			}
			decoder.sequence++
			events = append(events, delta)
		}
		completed, err := inference.NewToolCallCompletedEvent(
			decoder.sequence,
			tool.output,
			0,
			callID,
			tool.name,
			[]byte(arguments),
		)
		if err != nil {
			return nil, err
		}
		decoder.sequence++
		itemDone, err := inference.NewOutputItemCompletedEvent(
			decoder.sequence,
			tool.output,
			tool.itemID,
		)
		if err != nil {
			return nil, err
		}
		decoder.sequence++
		tool.complete = true
		decoder.anyTool = true
		events = append(events, completed, itemDone)
	}
	return events, nil
}

func isJSONObject(raw string) bool {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || trimmed[0] != '{' {
		return false
	}
	var value map[string]any
	return json.Unmarshal([]byte(trimmed), &value) == nil
}

// stopReasonForChat 把 Chat finish_reason 映射到 Canonical 停止原因。
func stopReasonForChat(finishReason string) inference.StopReason {
	switch strings.ToLower(strings.TrimSpace(finishReason)) {
	case "length":
		return inference.StopReasonMaxTokens
	case "tool_calls", "function_call":
		return inference.StopReasonToolUse
	case "content_filter":
		return inference.StopReasonContentFilter
	default:
		return inference.StopReasonEndTurn
	}
}
