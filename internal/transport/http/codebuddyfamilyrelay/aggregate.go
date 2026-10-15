package codebuddyfamilyrelay

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"time"
)

// AggregatedCompletion 是非流式聚合的结果。
type AggregatedCompletion struct {
	// Payload 是单个 `chat.completion` JSON。
	Payload []byte
	// SawDone 表示上游给了 `[DONE]`。
	SawDone bool
	// SawChunk 表示至少解析出一个 chunk（空流与「只给了 [DONE]」据此区分）。
	SawChunk bool
}

// aggregatedMessage 是聚合后的助手消息。
//
// `content` 始终存在（可能为空串）；`tool_calls` / `function_call` 只在真的有内容时出现——
// 上游把工具调用放在流式 delta 里，丢掉它会让客户端收到 `finish_reason: tool_calls`
// 却没有任何工具可执行（表现为「模型回答为空」）；反过来，空占位也不得凭空造出字段。
type aggregatedMessage struct {
	Role         string                 `json:"role"`
	Content      string                 `json:"content"`
	ToolCalls    []aggregatedToolCall   `json:"tool_calls,omitempty"`
	FunctionCall *aggregatedFunctionCal `json:"function_call,omitempty"`
}

// aggregatedToolCall 是非流式约定形态：不带流式分片序号 `index`，也不替上游编造 `id`。
type aggregatedToolCall struct {
	ID       string                `json:"id,omitempty"`
	Type     string                `json:"type"`
	Function aggregatedFunctionCal `json:"function"`
}

// aggregatedFunctionCal 是工具名 + 已拼接的入参 JSON 文本。
type aggregatedFunctionCal struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// aggregatedChoice 是聚合后的唯一 choice。
type aggregatedChoice struct {
	Index        int               `json:"index"`
	Message      aggregatedMessage `json:"message"`
	FinishReason string            `json:"finish_reason"`
}

// aggregatedCompletion 的字段顺序即输出顺序（Go 按声明顺序序列化）。
type aggregatedCompletion struct {
	ID      string             `json:"id"`
	Object  string             `json:"object"`
	Created int64              `json:"created"`
	Model   string             `json:"model"`
	Choices []aggregatedChoice `json:"choices"`
	Usage   json.RawMessage    `json:"usage,omitempty"`
}

// toolCallAccumulator 是按 index 归并中的工具调用。
type toolCallAccumulator struct {
	index     int
	id        string
	callType  string
	name      string
	arguments string
}

// AggregateSSE 把上游 SSE 文本聚合成一个非流式 `chat.completion`。
//
// 客户端要非流式、而上游只给流（约束 2），这是唯一能同时满足两边的做法。
// 累积 `delta.content`、`delta.tool_calls`（含历史 `function_call`）与最后一次出现的
// `usage`；`reasoning_content` 等富字段不属于 OpenAI chat.completion 的约定字段，
// 聚合时丢弃（流式路径照常逐字节透传，不受影响）。
//
// 解析刻意**逐字段宽容**：与 Node 侧同口径——单个字段类型不符不应当让整条流作废。
func AggregateSSE(sse []byte, clock func() time.Time) AggregatedCompletion {
	result := AggregatedCompletion{}
	accumulators := map[int]*toolCallAccumulator{}
	var legacy *aggregatedFunctionCal
	id, model := "", ""
	var created int64
	var usage json.RawMessage
	content := ""
	finishReason := "stop"

	for _, rawLine := range strings.Split(string(sse), "\n") {
		line := strings.TrimSpace(strings.TrimSuffix(rawLine, "\r"))
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(line[len("data:"):])
		if payload == "" {
			continue
		}
		if payload == "[DONE]" {
			result.SawDone = true
			continue
		}
		chunk, ok := decodeRawObject([]byte(payload))
		if !ok {
			continue
		}
		result.SawChunk = true
		if value, ok := rawString(chunk["id"]); ok {
			id = value
		}
		if value, ok := rawString(chunk["model"]); ok {
			model = value
		}
		if value, ok := rawInt64(chunk["created"]); ok {
			created = value
		}
		if value, ok := chunk["usage"]; ok && isJSONObject(value) {
			usage = value
		}
		for _, choice := range rawArray(chunk["choices"]) {
			parsed, ok := decodeRawObject(choice)
			if !ok {
				continue
			}
			if delta, ok := decodeRawObject(parsed["delta"]); ok {
				if value, ok := rawString(delta["content"]); ok {
					content += value
				}
				for _, call := range rawArray(delta["tool_calls"]) {
					mergeToolCallDelta(accumulators, call)
				}
				legacy = mergeLegacyFunctionCallDelta(legacy, delta["function_call"])
			}
			if value, ok := rawString(parsed["finish_reason"]); ok {
				finishReason = value
			}
		}
	}

	message := aggregatedMessage{Role: "assistant", Content: content}
	if calls := collapseToolCalls(accumulators); len(calls) > 0 {
		message.ToolCalls = calls
	}
	if legacy != nil {
		message.FunctionCall = legacy
	}
	if id == "" {
		id = "chatcmpl-codebuddy-" + strconv.FormatInt(nowMillis(clock), 10)
	}
	if created == 0 {
		created = nowMillis(clock) / 1000
	}
	if model == "" {
		model = "unknown"
	}
	payload, err := json.Marshal(aggregatedCompletion{
		ID:      id,
		Object:  "chat.completion",
		Created: created,
		Model:   model,
		Choices: []aggregatedChoice{{Index: 0, Message: message, FinishReason: finishReason}},
		Usage:   usage,
	})
	if err != nil {
		// 结构体只含可序列化字段，这里不可能失败；失败时给空 payload 由调用方按错误处理。
		return AggregatedCompletion{SawDone: result.SawDone, SawChunk: result.SawChunk}
	}
	result.Payload = payload
	return result
}

// mergeToolCallDelta 按 `index` 归并一帧 `delta.tool_calls[]`。
//
// 上游的工具调用走**标准 OpenAI 流式形态**（2026-10-14 实测）：首帧给
// `{index,id,type,function:{name,arguments:”}}`，随后按帧下发 `arguments` 分片，
// `index` 区分并行调用。名称只认第一次出现的非空值，入参按帧拼接。
func mergeToolCallDelta(accumulators map[int]*toolCallAccumulator, raw json.RawMessage) {
	delta, ok := decodeRawObject(raw)
	if !ok {
		return
	}
	index := 0
	if value, ok := rawInt64(delta["index"]); ok {
		index = int(value)
	}
	current, exists := accumulators[index]
	if !exists {
		current = &toolCallAccumulator{index: index, callType: "function"}
		accumulators[index] = current
	}
	if value, ok := rawString(delta["id"]); ok && value != "" && current.id == "" {
		current.id = value
	}
	if value, ok := rawString(delta["type"]); ok && value != "" {
		current.callType = value
	}
	if function, ok := decodeRawObject(delta["function"]); ok {
		if value, ok := rawString(function["name"]); ok && value != "" && current.name == "" {
			current.name = value
		}
		if value, ok := rawString(function["arguments"]); ok && value != "" {
			current.arguments += value
		}
	}
}

// mergeLegacyFunctionCallDelta 归并历史单工具形态 `delta.function_call`。
//
// 内容全空时返回原值（保持 nil），于是聚合结果里不会多出一个空的 `function_call` 字段——
// 上游的富字段里本来就带一个 `{name:”,arguments:”}` 的空占位，照抄会凭空造出字段。
func mergeLegacyFunctionCallDelta(
	current *aggregatedFunctionCal,
	raw json.RawMessage,
) *aggregatedFunctionCal {
	delta, ok := decodeRawObject(raw)
	if !ok {
		return current
	}
	name, _ := rawString(delta["name"])
	args, _ := rawString(delta["arguments"])
	if name == "" && args == "" {
		return current
	}
	base := current
	if base == nil {
		base = &aggregatedFunctionCal{}
	}
	if base.Name == "" {
		base.Name = name
	}
	base.Arguments += args
	return base
}

// collapseToolCalls 把归并结果按 index 升序折成非流式形态。
func collapseToolCalls(accumulators map[int]*toolCallAccumulator) []aggregatedToolCall {
	if len(accumulators) == 0 {
		return nil
	}
	indexes := make([]int, 0, len(accumulators))
	for index := range accumulators {
		indexes = append(indexes, index)
	}
	sort.Ints(indexes)
	calls := make([]aggregatedToolCall, 0, len(indexes))
	for _, index := range indexes {
		current := accumulators[index]
		calls = append(calls, aggregatedToolCall{
			ID:       current.id,
			Type:     current.callType,
			Function: aggregatedFunctionCal{Name: current.name, Arguments: current.arguments},
		})
	}
	return calls
}

// nowMillis 取当前毫秒（时钟可注入，便于测试生成稳定的兜底 id）。
func nowMillis(clock func() time.Time) int64 {
	if clock == nil {
		return time.Now().UnixMilli()
	}
	return clock().UnixMilli()
}

// decodeRawObject 解析 JSON 对象；不是对象时返回 false（逐字段宽容）。
func decodeRawObject(raw json.RawMessage) (map[string]json.RawMessage, bool) {
	if !isJSONObject(raw) {
		return nil, false
	}
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, false
	}
	return fields, true
}

// isJSONObject 判断原始字节是否为 JSON 对象（nil / 空 / 其它类型都是 false）。
func isJSONObject(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	return len(trimmed) > 0 && trimmed[0] == '{'
}

// rawString 只接受 JSON 字符串（与 Node 的 typeof === 'string' 同口径）。
func rawString(raw json.RawMessage) (string, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

// rawInt64 接受数字或数字字符串（Node 的 Number() 会同时接受两者）。
func rawInt64(raw json.RawMessage) (int64, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) == 0 {
		return 0, false
	}
	if trimmed[0] == '"' {
		value, ok := rawString(raw)
		if !ok {
			return 0, false
		}
		trimmed = strings.TrimSpace(value)
	}
	if parsed, err := strconv.ParseInt(trimmed, 10, 64); err == nil {
		return parsed, true
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return 0, false
	}
	return int64(parsed), true
}

// rawArray 解析 JSON 数组；不是数组时返回 nil。
func rawArray(raw json.RawMessage) []json.RawMessage {
	items, err := decodeRawArray(raw)
	if err != nil {
		return nil
	}
	return items
}
