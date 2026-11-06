package relaycore

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

// anthropicUsageWire 是 Anthropic Messages 的 usage 片段。
//
// 字段全部用指针：message_start 只给输入侧、message_delta 只给输出侧，
// 缺省必须与「明确为 0」区分开，否则后到的帧会把先到的值抹成 0。
type anthropicUsageWire struct {
	InputTokens              *uint64 `json:"input_tokens"`
	OutputTokens             *uint64 `json:"output_tokens"`
	CacheReadInputTokens     *uint64 `json:"cache_read_input_tokens"`
	CacheCreationInputTokens *uint64 `json:"cache_creation_input_tokens"`
}

// anthropicContentWire 是 Anthropic 内容块；只保留转换用得到的字段。
type anthropicContentWire struct {
	Type  string          `json:"type"`
	Text  string          `json:"text"`
	ID    string          `json:"id"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
}

// anthropicMessageWire 是完整的 Anthropic Message 正文。
type anthropicMessageWire struct {
	ID         string                 `json:"id"`
	Type       string                 `json:"type"`
	Model      string                 `json:"model"`
	Content    []anthropicContentWire `json:"content"`
	StopReason string                 `json:"stop_reason"`
	Usage      *anthropicUsageWire    `json:"usage"`
}

// anthropicChatUsageWire 是 Anthropic usage 在 Chat 协议里的等价形态。
//
// 字段名与 canonical Chat Renderer 输出的 usage 完全一致：客户端不该因为
// 「这次走的是透传通道」而看到另一套 usage 结构。
type anthropicChatUsageWire struct {
	PromptTokens            uint64                              `json:"prompt_tokens"`
	CompletionTokens        uint64                              `json:"completion_tokens"`
	TotalTokens             uint64                              `json:"total_tokens"`
	PromptTokensDetails     anthropicPromptTokenDetailsWire     `json:"prompt_tokens_details"`
	CompletionTokensDetails anthropicCompletionTokenDetailsWire `json:"completion_tokens_details"`
}

// anthropicPromptTokenDetailsWire 是输入侧的缓存子集。
type anthropicPromptTokenDetailsWire struct {
	CachedTokens     uint64 `json:"cached_tokens"`
	CacheWriteTokens uint64 `json:"cache_write_tokens,omitempty"`
}

// anthropicCompletionTokenDetailsWire 是输出侧的 reasoning 子集。
type anthropicCompletionTokenDetailsWire struct {
	ReasoningTokens uint64 `json:"reasoning_tokens"`
}

// anthropicAggregate 把两种上游形态（完整 Message 或事件流）收敛成同一份中间态。
//
// 为什么收敛：zcode 这类上游说 Anthropic 协议，而客户端在 chat completions 入口上
// 期待 OpenAI 形态。转换只在这一层做一次，Provider 只负责把字节送达。
type anthropicAggregate struct {
	responseID string
	model      string
	text       strings.Builder
	toolCalls  []aggregatedToolCall
	stopReason string
	input      uint64
	output     uint64
	cacheRead  uint64
	cacheWrite uint64
	hasUsage   bool
}

// absorbUsage 合并一帧 usage 的已给字段。
//
// 取最大值而不是覆盖：Anthropic 的 message_start 与 message_delta 各给一半，
// 而多帧重复上报时既有累计值也有本帧增量，取最大值对两种写法都正确。
func (aggregate *anthropicAggregate) absorbUsage(usage *anthropicUsageWire) {
	if usage == nil {
		return
	}
	aggregate.hasUsage = true
	maxInto := func(target *uint64, value *uint64) {
		if value != nil && *value > *target {
			*target = *value
		}
	}
	maxInto(&aggregate.input, usage.InputTokens)
	maxInto(&aggregate.output, usage.OutputTokens)
	maxInto(&aggregate.cacheRead, usage.CacheReadInputTokens)
	maxInto(&aggregate.cacheWrite, usage.CacheCreationInputTokens)
}

// appendBlock 按内容块类型累积文本或工具调用。
//
// thinking 块刻意丢弃：Chat 的非流式 message 没有约定的 thinking 字段，
// 与既有 OpenAI 聚合「reasoning_content 不进入非流式响应」保持同一取舍。
func (aggregate *anthropicAggregate) appendBlock(block anthropicContentWire, arguments string) {
	switch block.Type {
	case "text":
		aggregate.text.WriteString(block.Text)
	case "tool_use":
		call := aggregatedToolCall{
			ID:   block.ID,
			Type: "function",
			Function: aggregatedFunctionCal{
				Name:      block.Name,
				Arguments: arguments,
			},
		}
		if call.Function.Arguments == "" {
			// 无参工具在 Anthropic 里是空 input；Chat 侧约定要一个合法 JSON Object 文本。
			call.Function.Arguments = "{}"
		}
		aggregate.toolCalls = append(aggregate.toolCalls, call)
	}
}

// build 把中间态编码成非流式 chat.completion。
func (aggregate *anthropicAggregate) build(options AggregateOptions) AggregatedCompletion {
	id := aggregate.responseID
	if id == "" {
		prefix := strings.TrimSpace(options.FallbackIDPrefix)
		if prefix == "" {
			prefix = "chatcmpl"
		}
		id = prefix + "-" + strconv.FormatInt(NowMillis(options.Clock), 10)
	}
	message := aggregatedMessage{Role: "assistant", Content: aggregate.text.String()}
	if len(aggregate.toolCalls) > 0 {
		message.ToolCalls = aggregate.toolCalls
	}
	// 上游正文没给 model 时回落客户端请求的模型：响应里的 model 是客户端
	// 判断「谁回答的」的唯一依据，空值或占位值都会让这条信息丢失。
	model := strings.TrimSpace(aggregate.model)
	if model == "" {
		model = strings.TrimSpace(options.RequestedModel)
	}
	payload, err := json.Marshal(aggregatedCompletion{
		ID:      id,
		Object:  "chat.completion",
		Created: NowMillis(options.Clock) / 1000,
		Model:   model,
		Choices: []aggregatedChoice{{
			Index:        0,
			Message:      message,
			FinishReason: anthropicFinishReason(aggregate.stopReason),
		}},
		Usage: aggregate.usagePayload(),
	})
	if err != nil {
		// 结构体只含可序列化字段；失败时交回「没有 payload」，由调用方按上游不可用处理。
		return AggregatedCompletion{SawChunk: true, SawDone: true}
	}
	return AggregatedCompletion{Payload: payload, SawChunk: true, SawDone: true}
}

// usagePayload 把 Anthropic 的输入/输出/缓存分项合成为 Chat usage。
//
// Anthropic 的 input_tokens 不含缓存读写，而 Chat 的 prompt_tokens 是整段输入：
// 缓存命中并入 prompt_tokens，同时在 prompt_tokens_details 里保留子集——
// 与 canonical Claude 上游适配器（internal/adapters/claude/messages/usage.go）同口径，
// 否则同一个账号在两条通道上会算出两种输入量。
func (aggregate *anthropicAggregate) usagePayload() json.RawMessage {
	usage := aggregate.chatUsageWire()
	if usage == nil {
		return nil
	}
	payload, err := json.Marshal(usage)
	if err != nil {
		return nil
	}
	return payload
}

// chatUsageWire 返回 Chat 形态的用量；没读到任何 usage 时返回 nil。
//
// 单独抽出来是因为流式转换要复用同一份口径：它不产出整段 JSON，但收尾帧里的 usage
// 必须和非流式逐字段一致，否则同一个账号在两条通道上会算出两种输入量。
func (aggregate *anthropicAggregate) chatUsageWire() *anthropicChatUsageWire {
	if !aggregate.hasUsage {
		return nil
	}
	prompt := aggregate.input + aggregate.cacheRead + aggregate.cacheWrite
	return &anthropicChatUsageWire{
		PromptTokens:     prompt,
		CompletionTokens: aggregate.output,
		TotalTokens:      prompt + aggregate.output,
		PromptTokensDetails: anthropicPromptTokenDetailsWire{
			CachedTokens:     aggregate.cacheRead,
			CacheWriteTokens: aggregate.cacheWrite,
		},
	}
}

// anthropicFinishReason 把 Anthropic stop_reason 映射为 Chat 公开枚举。
//
// 无法识别时退回 stop：上游新增枚举不该让整条响应失败（与 Node 侧同口径）。
func anthropicFinishReason(reason string) string {
	switch strings.TrimSpace(reason) {
	case "max_tokens":
		return "length"
	case "tool_use":
		return "tool_calls"
	case "refusal":
		return "content_filter"
	default:
		return "stop"
	}
}

// aggregateAnthropicMessage 把一条完整的 Anthropic Message 转成 chat.completion。
//
// 为什么需要它：客户端请求非流式时上游会直接给整段 JSON（zcode 就是如此）。
// 旧实现一律把响应体当 OpenAI SSE 解析，纯 JSON 里没有 data: 行，于是聚合成
// model="unknown"、content 为空、无 usage 的假响应——把「模型其实答了」洗成空。
//
// ok=false 表示这份正文不是 Anthropic Message，调用方应原样交付（或另作处理），
// 绝不能拿它去覆盖上游已经写好的响应。
func aggregateAnthropicMessage(body []byte, options AggregateOptions) (AggregatedCompletion, bool) {
	var message anthropicMessageWire
	if err := json.Unmarshal(body, &message); err != nil {
		return AggregatedCompletion{}, false
	}
	// type=message 是 Anthropic Messages 的身份位；OpenAI 的 chat.completion 没有它。
	if message.Type != "message" {
		return AggregatedCompletion{}, false
	}
	aggregate := anthropicAggregate{responseID: message.ID, model: message.Model}
	aggregate.absorbUsage(message.Usage)
	for _, block := range message.Content {
		arguments := ""
		if block.Type == "tool_use" && len(block.Input) > 0 {
			arguments = string(block.Input)
		}
		aggregate.appendBlock(block, arguments)
	}
	aggregate.stopReason = message.StopReason
	return aggregate.build(options), true
}

// looksLikeAnthropicStream 判断一段 SSE 是否是 Anthropic Messages 事件流。
//
// 只看第一个 data: 负载的 type：OpenAI chunk 不带 type 字段，不会误判；
// 反过来 Anthropic 事件也从不带 object=chat.completion.chunk。
func looksLikeAnthropicStream(payload []byte) bool {
	for _, line := range strings.Split(string(payload), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(line[len("data:"):])
		if data == "" || data == "[DONE]" {
			continue
		}
		var event struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			continue
		}
		switch event.Type {
		case "message_start", "message_delta", "message_stop",
			"content_block_start", "content_block_delta", "content_block_stop":
			return true
		case "ping":
			// 心跳没有语义，真正的首事件在它后面。
			continue
		}
		return false
	}
	return false
}

// aggregateAnthropicSSE 聚合 Anthropic 事件流；ok=false 表示不是这种协议。
func aggregateAnthropicSSE(payload []byte, options AggregateOptions) (AggregatedCompletion, bool) {
	if !looksLikeAnthropicStream(payload) {
		return AggregatedCompletion{}, false
	}
	type blockState struct {
		block     anthropicContentWire
		arguments strings.Builder
	}
	aggregate := anthropicAggregate{}
	blocks := map[int]*blockState{}
	for _, line := range strings.Split(string(payload), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(line[len("data:"):])
		if data == "" || data == "[DONE]" {
			continue
		}
		var event struct {
			Type         string                `json:"type"`
			Index        *int                  `json:"index"`
			Message      *anthropicMessageWire `json:"message"`
			ContentBlock *anthropicContentWire `json:"content_block"`
			Delta        *struct {
				Type        string `json:"type"`
				Text        string `json:"text"`
				PartialJSON string `json:"partial_json"`
				StopReason  string `json:"stop_reason"`
			} `json:"delta"`
			Usage *anthropicUsageWire `json:"usage"`
		}
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			continue
		}
		switch event.Type {
		case "message_start":
			if event.Message == nil {
				continue
			}
			aggregate.responseID = event.Message.ID
			aggregate.model = event.Message.Model
			aggregate.absorbUsage(event.Message.Usage)
		case "content_block_start":
			if event.Index == nil || event.ContentBlock == nil {
				continue
			}
			// 块首可能已经带了一段文本；后续 text_delta 是它的增量，两者都要保留。
			blocks[*event.Index] = &blockState{block: *event.ContentBlock}
		case "content_block_delta":
			if event.Index == nil || event.Delta == nil {
				continue
			}
			state, ok := blocks[*event.Index]
			if !ok {
				continue
			}
			switch event.Delta.Type {
			case "text_delta":
				state.block.Text += event.Delta.Text
			case "input_json_delta":
				state.arguments.WriteString(event.Delta.PartialJSON)
			}
		case "message_delta":
			if event.Delta != nil && event.Delta.StopReason != "" {
				aggregate.stopReason = event.Delta.StopReason
			}
			aggregate.absorbUsage(event.Usage)
		}
	}
	indices := make([]int, 0, len(blocks))
	for index := range blocks {
		indices = append(indices, index)
	}
	// 按块序号还原生成顺序：文本与工具调用的先后由 index 决定，而不是 map 遍历顺序。
	sort.Ints(indices)
	for _, index := range indices {
		state := blocks[index]
		aggregate.appendBlock(state.block, state.arguments.String())
	}
	return aggregate.build(options), true
}

// isSSEPayload 判断上游响应体是不是事件流。
//
// 判据优先看 Content-Type，缺失时看正文首行。只有确认是流才交给聚合器：
// 完整 JSON 一律原样交付——重建不是「保真」，会丢上游多给的字段。
func isSSEPayload(header http.Header, payload []byte) bool {
	if isEventStreamContentType(header) {
		return true
	}
	trimmed := strings.TrimSpace(string(payload))
	return strings.HasPrefix(trimmed, "data:") || strings.HasPrefix(trimmed, "event:")
}
