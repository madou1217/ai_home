package relaycore

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// 本文件承接「客户端说 Chat 协议、上游说 Anthropic Messages 协议」的**流式**响应。
//
// 为什么必须逐事件转换：zcode 这类上游在 /v1/messages 上回的是
// `event: message_start` / `content_block_delta` 事件流，而本入口
// （/v1/chat/completions）的客户端只认 `data: {"object":"chat.completion.chunk"}`。
// 原样透传不会报错，客户端只是永远读不到 choices —— 表现为「请求成功但没有回答」，
// 与非流式那次把 Anthropic Message 当 OpenAI SSE 解析的事故同源。
//
// 与非流式的分界：非流式整段聚合（aggregate_anthropic.go）一次性产出 chat.completion；
// 流式必须边读边写，因此这里是**增量**状态机，不能复用聚合器。两边只共享 usage 口径
// （anthropicAggregate.chatUsageWire），避免同一账号在两条通道上算出两种 token 数。

// anthropicStreamProbeBytes 是协议判定允许预读的字节上限。
const anthropicStreamProbeBytes = 64 * 1024

// anthropicStreamProbeEvents 是协议判定允许预读的事件数。
//
// 为什么不是「只看首帧」：上游可能在真正的事件之前发若干 ping 心跳，只看首帧会把
// Anthropic 流误判成未知协议，然后原样透传（正是要修的那个 bug）。
const anthropicStreamProbeEvents = 4

// streamReadBufferBytes 是流式转换的读缓冲大小。
const streamReadBufferBytes = 32 * 1024

// chatCompletionChunk 是 OpenAI chat.completion.chunk 的线上形态。
//
// 字段与非流式聚合结果（aggregatedCompletion）刻意保持同一取名口径：客户端不该
// 因为「这次是流式」而看到另一套字段名。
type chatCompletionChunk struct {
	ID      string                  `json:"id"`
	Object  string                  `json:"object"`
	Created int64                   `json:"created"`
	Model   string                  `json:"model"`
	Choices []chatChunkChoice       `json:"choices"`
	Usage   *anthropicChatUsageWire `json:"usage,omitempty"`
}

// chatChunkChoice 是单 choice 的增量或收尾帧。
type chatChunkChoice struct {
	Index int            `json:"index"`
	Delta chatChunkDelta `json:"delta"`
	// FinishReason 在非收尾帧里必须是 null（指针区分「没有」与「stop」）。
	FinishReason *string `json:"finish_reason"`
}

// chatChunkDelta 是 Chat 可增量表达的助手字段。
type chatChunkDelta struct {
	// Role 只在首帧出现。
	Role string `json:"role,omitempty"`
	// Content 是普通文本增量。
	Content string `json:"content,omitempty"`
	// ReasoningContent 是可见推理增量（OpenAI 官方没有该字段，但 DeepSeek/vLLM
	// 生态已把它作为 thinking 的约定承载；非流式 message 没有这个约定，故那边丢弃）。
	ReasoningContent string `json:"reasoning_content,omitempty"`
	// ToolCalls 是一个或多个函数调用增量。
	ToolCalls []chatChunkToolCall `json:"tool_calls,omitempty"`
}

// chatChunkToolCall 是按工具序号定位的函数调用增量。
type chatChunkToolCall struct {
	Index uint32 `json:"index"`
	// ID 与 Type 只在工具首帧出现。
	ID       string             `json:"id,omitempty"`
	Type     string             `json:"type,omitempty"`
	Function *chatChunkFunction `json:"function,omitempty"`
}

// chatChunkFunction 保存工具名与参数分片。
type chatChunkFunction struct {
	// Name 只在首帧出现。
	Name string `json:"name,omitempty"`
	// Arguments 不加 omitempty：首帧要显式给空串，客户端据此建立参数缓冲区。
	Arguments string `json:"arguments"`
}

// anthropicStreamBlockWire 是 content_block_start 里的内容块。
//
// 只保留流式转换用得到的字段；input 刻意不读：Anthropic 的流式约定是块首给空
// input、参数全部走 input_json_delta（与非流式聚合器同口径），照读会重复拼参数。
type anthropicStreamBlockWire struct {
	Type     string `json:"type"`
	Text     string `json:"text"`
	Thinking string `json:"thinking"`
	ID       string `json:"id"`
	Name     string `json:"name"`
}

// anthropicStreamDeltaWire 是 content_block_delta / message_delta 共用的 delta 片段。
type anthropicStreamDeltaWire struct {
	Type        string `json:"type"`
	Text        string `json:"text"`
	Thinking    string `json:"thinking"`
	PartialJSON string `json:"partial_json"`
	StopReason  string `json:"stop_reason"`
}

// anthropicStreamErrorWire 是流中途的 error 事件正文。
type anthropicStreamErrorWire struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

// anthropicStreamEvent 是一条 data: 负载的联合视图；按 type 取用其中一段。
type anthropicStreamEvent struct {
	Type         string                    `json:"type"`
	Index        *int                      `json:"index"`
	Message      *anthropicMessageWire     `json:"message"`
	ContentBlock *anthropicStreamBlockWire `json:"content_block"`
	Delta        *anthropicStreamDeltaWire `json:"delta"`
	Usage        *anthropicUsageWire       `json:"usage"`
	Error        *anthropicStreamErrorWire `json:"error"`
}

// anthropicStreamBlockState 记录一个内容块的转换状态。
type anthropicStreamBlockState struct {
	kind string
	// toolIndex 是 OpenAI 的 tool_calls 序号（只在工具调用之间计数）。
	toolIndex uint32
	// sawArguments 表示已经写过参数分片；用于收尾时给无参工具补 "{}"。
	sawArguments bool
}

// anthropicStreamConverter 是 Anthropic 事件流 → OpenAI chunk 的增量状态机。
type anthropicStreamConverter struct {
	destination io.Writer
	options     AggregateOptions

	id      string
	model   string
	created int64
	// usage 复用非流式的合并逻辑：input_tokens 不含缓存读写，prompt_tokens 必须把
	// cache_read / cache_creation 并进来（见 anthropicAggregate.chatUsageWire）。
	usage anthropicAggregate
	// blocks 按 Anthropic 的内容块序号索引。
	blocks     map[int]*anthropicStreamBlockState
	toolCount  uint32
	stopReason string
	finishSent bool
	doneSent   bool
}

// writeUpstreamStream 交付上游 2xx 的流式正文（响应头此时已经写出）。
//
// 分派依据是**上游协议**而不是 Provider：只有 Anthropic 事件流需要转换，OpenAI 兼容
// 上游保持逐字节透传——透传是保真的唯一做法，重建会丢掉上游多给的字段。
// 判定阶段读走的字节会先回放，两条分支都不会少内容。
func writeUpstreamStream(
	response http.ResponseWriter,
	body io.Reader,
	options AggregateOptions,
) {
	consumed, anthropic := looksLikeAnthropicEventStream(body)
	source := io.MultiReader(bytes.NewReader(consumed), body)
	if !anthropic {
		_ = copyStreaming(response, source)
		return
	}
	// 转换中途出错时响应头已经发出，只能中断这条流：再补状态码只会污染已开始的流。
	_ = streamAnthropicToChat(source, response, options)
}

// looksLikeAnthropicEventStream 预读事件来判定上游协议。
//
// 返回的 consumed 是判定期间读走的所有字节，调用方必须原样回放（一次 Read 可能
// 带回多个事件，甚至整条短流）。返回 false 时按「不是 Anthropic」处理：
// 这里的默认值是逐字节透传，误判成 Anthropic 会把正常响应改坏，反过来最多保持原状。
func looksLikeAnthropicEventStream(source io.Reader) (consumed []byte, anthropic bool) {
	if source == nil {
		return nil, false
	}
	// scanned 是 consumed 里已经判过的事件边界偏移。
	scanned := 0
	for attempt := 0; attempt < anthropicStreamProbeEvents; attempt++ {
		remaining := anthropicStreamProbeBytes - len(consumed)
		if remaining <= 0 {
			return consumed, false
		}
		prefix, _, truncated, err := peekFirstSSEEvent(source, remaining)
		consumed = append(consumed, prefix...)
		// 逐个判定已读到的完整事件：首个事件往往只是 ping 心跳，只看首帧会漏判。
		for scanned < len(consumed) {
			end := sseEventEnd(consumed[scanned:])
			if end == 0 {
				break
			}
			event := consumed[scanned : scanned+end]
			scanned += end
			if decided, isAnthropic := classifyAnthropicStreamEvent(sseEventData(event)); decided {
				return consumed, isAnthropic
			}
		}
		// 读错误与超限都放弃判定：已读字节照常回放，透传分支会把它们交给客户端。
		if err != nil || truncated {
			return consumed, false
		}
	}
	return consumed, false
}

// classifyAnthropicStreamEvent 判定一帧 data 载荷属于哪种协议。
//
// decided=false 表示这帧没有说话（注释心跳、只有 event: 行的心跳），必须继续往后看；
// decided=true 时 anthropic 给出结论。已知事件白名单只覆盖 Anthropic 的公开事件集：
// 新增事件不影响判定，因为首个有语义的事件一定是 message_start 或 content_block_*。
func classifyAnthropicStreamEvent(event []byte) (decided bool, anthropic bool) {
	payload := bytes.TrimSpace(event)
	if len(payload) == 0 {
		return false, false
	}
	// OpenAI 流的结束哨兵：出现它说明这条流不是 Anthropic 协议。
	if bytes.Equal(payload, []byte("[DONE]")) {
		return true, false
	}
	// 没有 data: 行的事件（注释心跳、只有 event: 行）拿不到 JSON 载荷，无法判定。
	if payload[0] != '{' {
		return false, false
	}
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(payload, &probe); err != nil {
		return true, false
	}
	switch probe.Type {
	case "message_start", "content_block_start", "content_block_delta",
		"content_block_stop", "message_delta", "message_stop", "error":
		return true, true
	case "ping":
		return false, false
	default:
		// Chat chunk 不带 type 字段（object=chat.completion.chunk）；这里任何
		// 不认识的 type 都按「不是 Anthropic」处置，绝不猜测。
		return true, false
	}
}

// streamAnthropicToChat 把 Anthropic 事件流逐帧转成 OpenAI chat.completion.chunk。
func streamAnthropicToChat(source io.Reader, destination io.Writer, options AggregateOptions) error {
	converter := &anthropicStreamConverter{
		destination: destination,
		options:     options,
		blocks:      map[int]*anthropicStreamBlockState{},
	}
	return converter.convert(source)
}

// convert 逐事件消费上游流。
func (converter *anthropicStreamConverter) convert(source io.Reader) error {
	reader := bufio.NewReaderSize(source, streamReadBufferBytes)
	for {
		event, err := readSSEEvent(reader)
		if err != nil {
			if errors.Is(err, io.EOF) {
				// 上游没给 message_stop 就断了：不补 finish/[DONE]。
				// 「正常结束」与「中途截断」必须可区分，编造收尾会把截断洗成完整回答。
				return nil
			}
			return err
		}
		if handleErr := converter.handle(sseEventData(event)); handleErr != nil {
			return handleErr
		}
		if converter.doneSent {
			return nil
		}
	}
}

// handle 分发一条事件负载。
func (converter *anthropicStreamConverter) handle(payload []byte) error {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 {
		return nil
	}
	// 少数代理在 Anthropic 流末尾也补一个 [DONE]：照样收尾即可。
	if bytes.Equal(trimmed, []byte("[DONE]")) {
		return converter.finish()
	}
	var event anthropicStreamEvent
	if err := json.Unmarshal(trimmed, &event); err != nil {
		// 单帧畸形不能让整条流作废：跳过并继续（与非流式聚合逐字段宽容同口径）。
		return nil
	}
	switch event.Type {
	case "message_start":
		return converter.startMessage(event.Message)
	case "content_block_start":
		return converter.startBlock(event.Index, event.ContentBlock)
	case "content_block_delta":
		return converter.delta(event.Index, event.Delta)
	case "content_block_stop":
		return converter.stopBlock(event.Index)
	case "message_delta":
		return converter.messageDelta(event.Delta, event.Usage)
	case "message_stop":
		return converter.finish()
	case "error":
		return converter.fail(event.Error)
	default:
		// ping 与未知事件：OpenAI 流里没有对应语义，安静丢弃。
		return nil
	}
}

// startMessage 生成首帧：id/model/role=assistant，并记下输入侧 usage。
//
// 首帧不带 usage：OpenAI 客户端的 usage 在收尾帧读，提前塞进去会被当成「已结束」。
func (converter *anthropicStreamConverter) startMessage(message *anthropicMessageWire) error {
	if message != nil {
		converter.id = strings.TrimSpace(message.ID)
		converter.model = strings.TrimSpace(message.Model)
		converter.usage.absorbUsage(message.Usage)
	}
	return converter.emit(chatChunkDelta{Role: "assistant"}, nil, nil)
}

// startBlock 处理内容块起始。
func (converter *anthropicStreamConverter) startBlock(
	index *int,
	block *anthropicStreamBlockWire,
) error {
	if index == nil || block == nil {
		return nil
	}
	state := &anthropicStreamBlockState{kind: block.Type}
	converter.blocks[*index] = state
	switch block.Type {
	case "text":
		// 块首可能已经带了一段文本；为空时等 text_delta，避免多发一帧空 content。
		if block.Text == "" {
			return nil
		}
		return converter.emit(chatChunkDelta{Content: block.Text}, nil, nil)
	case "thinking":
		if block.Thinking == "" {
			return nil
		}
		return converter.emit(chatChunkDelta{ReasoningContent: block.Thinking}, nil, nil)
	case "tool_use":
		// OpenAI 的 tool_calls[].index 只在工具调用之间计数，而 Anthropic 的 index
		// 是**所有**内容块（含 text/thinking）的序号：照抄会让客户端看到从 1 或 2
		// 开始的工具序号，或把工具装进错误的槽位。这里重新编号。
		state.toolIndex = converter.toolCount
		converter.toolCount++
		return converter.emit(chatChunkDelta{ToolCalls: []chatChunkToolCall{{
			Index: state.toolIndex,
			ID:    block.ID,
			Type:  "function",
			Function: &chatChunkFunction{
				Name:      block.Name,
				Arguments: "",
			},
		}}}, nil, nil)
	default:
		// redacted_thinking 等块没有可表达的内容，丢弃。
		return nil
	}
}

// delta 处理块内增量。
func (converter *anthropicStreamConverter) delta(
	index *int,
	delta *anthropicStreamDeltaWire,
) error {
	if index == nil || delta == nil {
		return nil
	}
	state := converter.blocks[*index]
	switch delta.Type {
	case "text_delta":
		if delta.Text == "" {
			return nil
		}
		return converter.emit(chatChunkDelta{Content: delta.Text}, nil, nil)
	case "thinking_delta":
		if delta.Thinking == "" {
			return nil
		}
		// reasoning 只在流式里保留：Chat 的 message 没有约定字段，非流式聚合因此
		// 丢弃（见 appendBlock）；流式的 reasoning_content 是 DeepSeek/vLLM 起的
		// 事实标准，丢掉会让客户端看不到模型「想过什么」。
		return converter.emit(chatChunkDelta{ReasoningContent: delta.Thinking}, nil, nil)
	case "input_json_delta":
		if state == nil || delta.PartialJSON == "" {
			return nil
		}
		state.sawArguments = true
		return converter.emit(chatChunkDelta{ToolCalls: []chatChunkToolCall{{
			Index:    state.toolIndex,
			Function: &chatChunkFunction{Arguments: delta.PartialJSON},
		}}}, nil, nil)
	default:
		// signature_delta / citations_delta：OpenAI 无对应字段，丢弃。
		return nil
	}
}

// stopBlock 处理内容块结束。
func (converter *anthropicStreamConverter) stopBlock(index *int) error {
	if index == nil {
		return nil
	}
	state := converter.blocks[*index]
	if state == nil || state.kind != "tool_use" || state.sawArguments {
		return nil
	}
	// 无参工具在 Anthropic 里没有任何 input_json_delta；OpenAI 客户端会 JSON.parse
	// 空串而失败，非流式路径同样补 "{}"——两条路径必须同口径。
	state.sawArguments = true
	return converter.emit(chatChunkDelta{ToolCalls: []chatChunkToolCall{{
		Index:    state.toolIndex,
		Function: &chatChunkFunction{Arguments: "{}"},
	}}}, nil, nil)
}

// messageDelta 生成收尾帧：finish_reason + usage。
//
// usage 必须在这一帧给出（而不是单独一帧 choices:[]）：非流式响应也把 usage 放在
// 同一个 chat.completion 里，客户端不该因为流式而换一种读法。prompt_tokens 含缓存
// 读写，口径见 anthropicAggregate.chatUsageWire。
func (converter *anthropicStreamConverter) messageDelta(
	delta *anthropicStreamDeltaWire,
	usage *anthropicUsageWire,
) error {
	if delta != nil && strings.TrimSpace(delta.StopReason) != "" {
		converter.stopReason = delta.StopReason
	}
	converter.usage.absorbUsage(usage)
	if converter.finishSent {
		// 正常协议只有一条 message_delta；重复上报不该让客户端结束两次。
		return nil
	}
	converter.finishSent = true
	reason := anthropicFinishReason(converter.stopReason)
	return converter.emit(chatChunkDelta{}, &reason, converter.usage.chatUsageWire())
}

// finish 补收尾帧并写 [DONE]。
func (converter *anthropicStreamConverter) finish() error {
	if !converter.finishSent {
		// 少数代理只发 message_stop：仍要给 finish_reason，否则客户端会一直等收尾。
		converter.finishSent = true
		reason := anthropicFinishReason(converter.stopReason)
		if err := converter.emit(chatChunkDelta{}, &reason, converter.usage.chatUsageWire()); err != nil {
			return err
		}
	}
	if converter.doneSent {
		return nil
	}
	converter.doneSent = true
	return converter.writeFrame([]byte("[DONE]"))
}

// fail 把流中途的 error 事件转成 OpenAI 的错误帧。
//
// 为什么不能丢：Anthropic 用 error 事件承载 overloaded_error 这类中途失败；丢掉它
// 客户端只会看到「回答突然截断」，既没有原因也没有可重试信号。
func (converter *anthropicStreamConverter) fail(payload *anthropicStreamErrorWire) error {
	errorType, message := "upstream_error", "上游返回错误"
	if payload != nil {
		if strings.TrimSpace(payload.Type) != "" {
			errorType = payload.Type
		}
		if strings.TrimSpace(payload.Message) != "" {
			message = payload.Message
		}
	}
	frame, err := json.Marshal(map[string]any{
		"error": map[string]string{"type": errorType, "message": message},
	})
	if err != nil {
		return err
	}
	if writeErr := converter.writeFrame(frame); writeErr != nil {
		return writeErr
	}
	if converter.doneSent {
		return nil
	}
	converter.doneSent = true
	return converter.writeFrame([]byte("[DONE]"))
}

// emit 编码并写出一帧 chunk。
func (converter *anthropicStreamConverter) emit(
	delta chatChunkDelta,
	finishReason *string,
	usage *anthropicChatUsageWire,
) error {
	payload, err := json.Marshal(chatCompletionChunk{
		ID:      converter.responseID(),
		Object:  "chat.completion.chunk",
		Created: converter.createdSeconds(),
		Model:   converter.responseModel(),
		Choices: []chatChunkChoice{{Index: 0, Delta: delta, FinishReason: finishReason}},
		Usage:   usage,
	})
	if err != nil {
		return err
	}
	return converter.writeFrame(payload)
}

// responseID 优先用上游 id；缺失时按非流式同一套规则生成兜底 id。
func (converter *anthropicStreamConverter) responseID() string {
	if converter.id != "" {
		return converter.id
	}
	prefix := strings.TrimSpace(converter.options.FallbackIDPrefix)
	if prefix == "" {
		prefix = "chatcmpl"
	}
	converter.id = prefix + "-" + strconv.FormatInt(NowMillis(converter.options.Clock), 10)
	return converter.id
}

// createdSeconds 全程只算一次：同一响应的所有帧必须共享 created。
func (converter *anthropicStreamConverter) createdSeconds() int64 {
	if converter.created == 0 {
		converter.created = NowMillis(converter.options.Clock) / 1000
	}
	return converter.created
}

// responseModel 上游没声明 model 时回落客户端请求的模型（与非流式同口径）。
func (converter *anthropicStreamConverter) responseModel() string {
	if converter.model != "" {
		return converter.model
	}
	return strings.TrimSpace(converter.options.RequestedModel)
}

// writeFrame 以 "data: " 前缀加一个空行写出负载，并立即刷新。
//
// 逐帧刷新是流式的全部意义：攒在缓冲区里等于把增量降级成一次性响应。
func (converter *anthropicStreamConverter) writeFrame(payload []byte) error {
	frame := make([]byte, 0, len(payload)+8)
	frame = append(frame, "data: "...)
	frame = append(frame, payload...)
	frame = append(frame, "\n\n"...)
	if _, err := converter.destination.Write(frame); err != nil {
		return err
	}
	if flusher, ok := converter.destination.(http.Flusher); ok {
		flusher.Flush()
	}
	return nil
}

// readSSEEvent 读取一个完整 SSE 事件（以空行结束），返回事件原文。
//
// 为什么不用 peekFirstSSEEvent：预读函数会一次性读走事件边界之后的字节，每帧都要
// 回放；按行切分只消费到当前事件结束，流式转换才能保持常数内存。
func readSSEEvent(reader *bufio.Reader) ([]byte, error) {
	var event []byte
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			content := bytes.TrimRight(line, "\r\n")
			if len(bytes.TrimSpace(content)) == 0 {
				if len(event) == 0 {
					// 事件之间的空行：没有内容可交付，继续读。
					continue
				}
				return event, nil
			}
			event = append(event, content...)
			event = append(event, '\n')
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				if len(event) == 0 {
					return nil, io.EOF
				}
				// 末尾没有空行的残事件照常交付，不吞内容。
				return event, nil
			}
			return nil, err
		}
	}
}
