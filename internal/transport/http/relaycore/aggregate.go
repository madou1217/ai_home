package relaycore

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

// AggregateOptions 是聚合的可注入项。
type AggregateOptions struct {
	// Clock 提供时间（可注入，便于测试生成稳定的兜底 id）。
	Clock func() time.Time
	// FallbackIDPrefix 是上游没给 id 时的兜底前缀（各 Provider 不同，故可注入）。
	// 为空时用 "chatcmpl"。
	FallbackIDPrefix string
}

// AggregateSSE 把上游 SSE 文本聚合成一个非流式 `chat.completion`。
//
// 客户端要非流式、而上游只给流时，这是唯一能同时满足两边的做法。
// 累积 `delta.content`、`delta.tool_calls`（含历史 `function_call`）与最后一次出现的
// `usage`；`reasoning_content` 等富字段不属于 OpenAI chat.completion 的约定字段，
// 聚合时丢弃（流式路径照常逐字节透传，不受影响）。
//
// 解析刻意**逐字段宽容**：与 Node 侧同口径——单个字段类型不符不应当让整条流作废。
//
// 这是**协议形状**的聚合，与具体 Provider 无关：任何 OpenAI chat completions 形态的
// 上游都产出同样的 SSE，因此只有一份实现。
func AggregateSSE(sse []byte, options AggregateOptions) AggregatedCompletion {
	clock := options.Clock
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
		chunk, ok := DecodeRawObject([]byte(payload))
		if !ok {
			continue
		}
		result.SawChunk = true
		if value, ok := RawString(chunk["id"]); ok {
			id = value
		}
		if value, ok := RawString(chunk["model"]); ok {
			model = value
		}
		if value, ok := RawInt64(chunk["created"]); ok {
			created = value
		}
		if value, ok := chunk["usage"]; ok && IsJSONObject(value) {
			usage = value
		}
		for _, choice := range RawArray(chunk["choices"]) {
			parsed, ok := DecodeRawObject(choice)
			if !ok {
				continue
			}
			if delta, ok := DecodeRawObject(parsed["delta"]); ok {
				if value, ok := RawString(delta["content"]); ok {
					content += value
				}
				for _, call := range RawArray(delta["tool_calls"]) {
					mergeToolCallDelta(accumulators, call)
				}
				legacy = mergeLegacyFunctionCallDelta(legacy, delta["function_call"])
			}
			if value, ok := RawString(parsed["finish_reason"]); ok {
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
		prefix := strings.TrimSpace(options.FallbackIDPrefix)
		if prefix == "" {
			prefix = "chatcmpl"
		}
		id = prefix + "-" + strconv.FormatInt(NowMillis(clock), 10)
	}
	if created == 0 {
		created = NowMillis(clock) / 1000
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
// 上游的工具调用走**标准 OpenAI 流式形态**：首帧给
// `{index,id,type,function:{name,arguments:""}}`，随后按帧下发 `arguments` 分片，
// `index` 区分并行调用。名称只认第一次出现的非空值，入参按帧拼接。
func mergeToolCallDelta(accumulators map[int]*toolCallAccumulator, raw json.RawMessage) {
	delta, ok := DecodeRawObject(raw)
	if !ok {
		return
	}
	index := 0
	if value, ok := RawInt64(delta["index"]); ok {
		index = int(value)
	}
	current, exists := accumulators[index]
	if !exists {
		current = &toolCallAccumulator{index: index, callType: "function"}
		accumulators[index] = current
	}
	if value, ok := RawString(delta["id"]); ok && value != "" && current.id == "" {
		current.id = value
	}
	if value, ok := RawString(delta["type"]); ok && value != "" {
		current.callType = value
	}
	if function, ok := DecodeRawObject(delta["function"]); ok {
		if value, ok := RawString(function["name"]); ok && value != "" && current.name == "" {
			current.name = value
		}
		if value, ok := RawString(function["arguments"]); ok && value != "" {
			current.arguments += value
		}
	}
}

// mergeLegacyFunctionCallDelta 归并历史单工具形态 `delta.function_call`。
//
// 内容全空时返回原值（保持 nil），于是聚合结果里不会多出一个空的 `function_call` 字段——
// 上游的富字段里本来就带一个 `{name:"",arguments:""}` 的空占位，照抄会凭空造出字段。
func mergeLegacyFunctionCallDelta(
	current *aggregatedFunctionCal,
	raw json.RawMessage,
) *aggregatedFunctionCal {
	delta, ok := DecodeRawObject(raw)
	if !ok {
		return current
	}
	name, _ := RawString(delta["name"])
	args, _ := RawString(delta["arguments"])
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
