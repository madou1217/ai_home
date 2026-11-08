package webuichatapi

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"

	"github.com/madou1217/ai_home/core/inference"
)

const (
	// doneSentinel 是 OpenAI 流的结束帧；它没有 JSON 负载，必须按字面识别。
	doneSentinel = "[DONE]"
	// byteLF / byteCR 是行结束符码点。用数值而不是转义写法，避免与内容里的换行混淆。
	byteLF byte = 0x0A
	byteCR byte = 0x0D
	// maxNonStreamBytes 限制非流式回退的读取上限，避免把整段大 JSON 读进内存。
	maxNonStreamBytes int64 = 8 * 1024 * 1024
)

// chunk 是一次上游读取得到的增量。
type chunk struct {
	// Content 是正文增量；空字符串表示这帧没有可见文本（首帧 role、心跳帧等）。
	Content string
	// FinishReason 非空表示上游声明本轮结束（stop / length / tool_calls …）。
	FinishReason string
}

// upstreamError 表示上游用业务错误信封代替了内容（HTTP 200 + {"error":{...}}）。
//
// 这类失败藏在 2xx 里，只看状态码会把它当成成功流；必须解析出来，否则前端会收到一条
// 永远不结束的空回复。
type upstreamError struct {
	Code    string
	Message string
}

func (err *upstreamError) Error() string { return err.Message }

// chatStreamReader 按 SSE 规范读取 chat.completions 增量。
//
// 为什么不用 bufio.Scanner：默认 64KB 上限会在超长帧上直接报错；这里用 Reader 按行读，
// 行长度只受内存约束，被拆到多次 Read 的一行也会自动拼好。
type chatStreamReader struct {
	reader     *bufio.Reader
	usage      usageAccumulator
	pending    strings.Builder
	pendingSet bool
	finished   bool
}

// newChatStreamReader 包装上游响应体。
func newChatStreamReader(body io.Reader) *chatStreamReader {
	return &chatStreamReader{reader: bufio.NewReader(body)}
}

// Next 返回下一批增量；第二个返回值为 false 表示流正常结束。
func (reader *chatStreamReader) Next() (chunk, bool, error) {
	if reader.finished {
		return chunk{}, false, nil
	}
	for {
		line, readErr := reader.reader.ReadString(byteLF)
		line = trimLineEnding(line)
		if line == "" && readErr == nil {
			// 空行是 SSE 的帧边界：把累积的 data 行解析成一块增量。
			result, hasResult, err := reader.endFrame()
			if err != nil {
				return chunk{}, false, err
			}
			if hasResult {
				return result, true, nil
			}
			if reader.finished {
				return chunk{}, false, nil
			}
			continue
		}
		reader.consumeLine(line)
		if readErr == nil {
			continue
		}
		// 到达流末尾：先把没有以空行收尾的最后一帧交付出去。
		result, hasResult, err := reader.endFrame()
		if err != nil {
			return chunk{}, false, err
		}
		if hasResult {
			return result, true, nil
		}
		if errors.Is(readErr, io.EOF) {
			reader.finished = true
			return chunk{}, false, nil
		}
		return chunk{}, false, readErr
	}
}

// consumeLine 吸收一行 SSE 字段。
func (reader *chatStreamReader) consumeLine(line string) {
	if line == "" || strings.HasPrefix(line, ":") {
		// 空行与注释帧（: heartbeat）不携带内容。
		return
	}
	field, value, hasValue := strings.Cut(line, ":")
	if !hasValue || field != "data" {
		// event / id / retry 字段对内容无意义：本切片只消费 data。
		return
	}
	value = strings.TrimPrefix(value, " ")
	if reader.pending.Len() > 0 {
		// 多行 data 按 SSE 规范用换行拼接。
		reader.pending.WriteByte(byteLF)
	}
	reader.pending.WriteString(value)
	reader.pendingSet = true
}

// endFrame 解析当前帧；没有待解析负载时返回 hasResult=false。
func (reader *chatStreamReader) endFrame() (chunk, bool, error) {
	if !reader.pendingSet {
		return chunk{}, false, nil
	}
	reader.pendingSet = false
	return reader.consumeFrame()
}

// consumeFrame 解析累积的负载，必要时结束整个流。
func (reader *chatStreamReader) consumeFrame() (chunk, bool, error) {
	payload := strings.TrimSpace(reader.pending.String())
	reader.pending.Reset()
	if payload == "" {
		return chunk{}, false, nil
	}
	if payload == doneSentinel {
		reader.finished = true
		return chunk{}, false, nil
	}
	result, err := parseChatPayload([]byte(payload))
	if err != nil {
		return chunk{}, false, err
	}
	reader.usage.absorb([]byte(payload))
	return result, result.Content != "" || result.FinishReason != "", nil
}

// Result 返回整条流累计到的用量。
func (reader *chatStreamReader) Result() (inference.Usage, bool) {
	return reader.usage.result()
}

// parseChatPayload 从一帧负载里读出正文与结束原因。
//
// 用 map 而不是结构体解析：上游的 choices 可能是空数组（只带 usage 的收尾帧），
// 也可能带额外字段，结构体会把前者解码成一个看不出区别的零值 choice。
func parseChatPayload(payload []byte) (chunk, error) {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	var document map[string]any
	if err := decoder.Decode(&document); err != nil {
		return chunk{}, &upstreamError{
			Code:    "chat_upstream_frame_invalid",
			Message: "上游返回了无法解析的数据帧",
		}
	}
	if object, ok := document["error"].(map[string]any); ok {
		return chunk{}, &upstreamError{
			Code:    "chat_upstream_error",
			Message: objectMessage(object),
		}
	}
	choices, _ := document["choices"].([]any)
	if len(choices) == 0 {
		return chunk{}, nil
	}
	choice, ok := choices[0].(map[string]any)
	if !ok {
		return chunk{}, nil
	}
	result := chunk{}
	if delta, ok := choice["delta"].(map[string]any); ok {
		result.Content, _ = delta["content"].(string)
	} else if message, ok := choice["message"].(map[string]any); ok {
		result.Content, _ = message["content"].(string)
	}
	if reason, ok := choice["finish_reason"].(string); ok {
		result.FinishReason = reason
	}
	return result, nil
}

// objectMessage 取错误信封里的 message，取不到时给一条固定文案。
func objectMessage(object map[string]any) string {
	if message, ok := object["message"].(string); ok && strings.TrimSpace(message) != "" {
		return strings.TrimSpace(message)
	}
	return "上游返回了业务错误"
}

// trimLineEnding 去掉行尾的 CR/LF；SSE 允许 LF、CRLF 与单独 CR 三种换行。
func trimLineEnding(line string) string {
	for len(line) > 0 {
		last := line[len(line)-1]
		if last != byteLF && last != byteCR {
			break
		}
		line = line[:len(line)-1]
	}
	return line
}

// readChatCompletionDocument 读取整段非流式响应（上游忽略了 stream:true 的情形）。
func readChatCompletionDocument(body io.Reader) (chunk, inference.Usage, bool, error) {
	document, err := io.ReadAll(io.LimitReader(body, maxNonStreamBytes))
	if err != nil {
		return chunk{}, inference.Usage{}, false, err
	}
	result, err := parseChatPayload(document)
	if err != nil {
		return chunk{}, inference.Usage{}, false, err
	}
	accumulator := usageAccumulator{}
	accumulator.absorb(document)
	usage, ok := accumulator.result()
	return result, usage, ok, nil
}

// usageAccumulator 从响应字节里提取 token 用量。
//
// 口径与 relaycore 的 usageAccumulator 一致（那边不导出，这里保留同一份规则）：
// 多帧重复上报时取最大值而不是相加——上游既有累计值也有增量写法，取最大值对两种都对。
type usageAccumulator struct {
	input      uint64
	output     uint64
	cached     uint64
	cacheWrite uint64
	reasoning  uint64
	found      bool
}

// absorb 吸收一个 JSON 负载。
func (accumulator *usageAccumulator) absorb(payload []byte) {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.UseNumber()
	var event map[string]any
	if err := decoder.Decode(&event); err != nil {
		return
	}
	usage, ok := event["usage"].(map[string]any)
	if !ok {
		return
	}
	accumulator.maxInto(&accumulator.input, usage["prompt_tokens"])
	accumulator.maxInto(&accumulator.input, usage["input_tokens"])
	accumulator.maxInto(&accumulator.output, usage["completion_tokens"])
	accumulator.maxInto(&accumulator.output, usage["output_tokens"])
	accumulator.maxInto(&accumulator.cached, usage["cache_read_input_tokens"])
	accumulator.maxInto(&accumulator.cacheWrite, usage["cache_creation_input_tokens"])
	if details, ok := usage["prompt_tokens_details"].(map[string]any); ok {
		accumulator.maxInto(&accumulator.cached, details["cached_tokens"])
	}
	if details, ok := usage["completion_tokens_details"].(map[string]any); ok {
		accumulator.maxInto(&accumulator.reasoning, details["reasoning_tokens"])
	}
}

// maxInto 取最大值；字段不是非负整数时视为没有该字段。
func (accumulator *usageAccumulator) maxInto(target *uint64, value any) {
	number, ok := value.(json.Number)
	if !ok {
		return
	}
	parsed, err := number.Int64()
	if err != nil || parsed < 0 {
		return
	}
	if uint64(parsed) <= *target {
		return
	}
	*target = uint64(parsed)
	accumulator.found = true
}

// result 生成领域用量。
//
// 缓存部分并进输入：领域模型要求 cached + cacheWrite ≤ input，而上游只报缓存命中值时
// 这个不等式并不成立，直接构造会让整条用量被校验拒绝。
func (accumulator *usageAccumulator) result() (inference.Usage, bool) {
	if !accumulator.found {
		return inference.Usage{}, false
	}
	input := accumulator.input
	if cached := accumulator.cached + accumulator.cacheWrite; cached > input {
		input = cached
	}
	usage, err := inference.NewUsage(inference.UsageInput{
		InputTokens:           input,
		OutputTokens:          accumulator.output,
		CachedInputTokens:     accumulator.cached,
		CacheWriteInputTokens: accumulator.cacheWrite,
		ReasoningTokens:       accumulator.reasoning,
	})
	if err != nil {
		return inference.Usage{}, false
	}
	return usage, true
}
