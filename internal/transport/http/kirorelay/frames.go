package kirorelay

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
)

// EventType 是 kiro 帧解码后的语义事件。
type EventType string

const (
	// EventConversation 是 initial-response 里的 conversationId。
	EventConversation EventType = "conversation"
	// EventText 是 assistantResponseEvent 的增量文本。
	EventText EventType = "text"
	// EventThinking 是 reasoningContentEvent 的推理增量。
	EventThinking EventType = "thinking"
	// EventToolStart 表示第一次见到某个 toolUseId。
	EventToolStart EventType = "tool_call_start"
	// EventToolDelta 是工具参数的增量分片。
	EventToolDelta EventType = "tool_call_delta"
	// EventToolDone 表示该次工具调用结束（stop=true 或流收尾）。
	EventToolDone EventType = "tool_call_done"
	// EventMetering 是 credits 计量。
	EventMetering EventType = "metering"
	// EventContextUsage 是上下文占用百分比。
	EventContextUsage EventType = "context_usage"
)

// Event 是一条语义事件；字段按 Type 取用。
type Event struct {
	Type       EventType
	Text       string
	ID         string
	Name       string
	Index      int
	Delta      string
	Arguments  string
	Unit       string
	Usage      float64
	Percentage float64
}

// ToolCall 是一次工具调用的累计状态。
type ToolCall struct {
	Index     int
	ID        string
	Name      string
	Arguments string
}

type toolCallState struct {
	call ToolCall
	done bool
}

// FrameDecoder 把帧序列转成语义事件。
//
// 与 Node 的 createKiroFrameDecoder 同语义；不同点：参数增量用 json.Number 读取，
// 计量值不会因为 float64 往返丢精度（Node 的 Number() 对超大整数会截断）。
type FrameDecoder struct {
	calls     map[string]*toolCallState
	order     []*toolCallState
	nextIndex int
}

// NewFrameDecoder 创建帧解码器。
func NewFrameDecoder() *FrameDecoder {
	return &FrameDecoder{calls: make(map[string]*toolCallState)}
}

// Decode 解码单帧；不是语义事件（未知类型/非法 JSON）时返回空。
func (decoder *FrameDecoder) Decode(frame Frame) []Event {
	if decoder == nil {
		return nil
	}
	document := parsePayload(frame.Payload)
	if document == nil {
		return nil
	}
	switch frame.EventType() {
	case "initial-response":
		if id := textValue(document["conversationId"]); id != "" {
			return []Event{{Type: EventConversation, ID: id}}
		}
	case "assistantResponseEvent":
		if text := textValue(document["content"]); text != "" {
			return []Event{{Type: EventText, Text: text}}
		}
	case "reasoningContentEvent":
		if text := textValue(document["text"]); text != "" {
			return []Event{{Type: EventThinking, Text: text}}
		}
	case "toolUseEvent":
		return decoder.decodeToolUse(document)
	case "meteringEvent":
		if usage, ok := numberValue(document["usage"]); ok {
			unit := textValue(document["unit"])
			if unit == "" {
				unit = "credit"
			}
			return []Event{{Type: EventMetering, Unit: unit, Usage: usage}}
		}
	case "contextUsageEvent":
		if percentage, ok := numberValue(document["contextUsagePercentage"]); ok {
			return []Event{{Type: EventContextUsage, Percentage: percentage}}
		}
	}
	return nil
}

func (decoder *FrameDecoder) decodeToolUse(document map[string]any) []Event {
	id := textValue(document["toolUseId"])
	if id == "" {
		return nil
	}
	events := make([]Event, 0, 2)
	call, exists := decoder.calls[id]
	if !exists {
		call = &toolCallState{call: ToolCall{Index: decoder.nextIndex, ID: id, Name: textValue(document["name"])}}
		decoder.nextIndex++
		decoder.calls[id] = call
		decoder.order = append(decoder.order, call)
		events = append(events, Event{Type: EventToolStart, Index: call.call.Index, ID: id, Name: call.call.Name})
	}
	delta := ""
	switch input := document["input"].(type) {
	case string:
		delta = input
	case map[string]any, []any:
		if encoded, err := json.Marshal(input); err == nil {
			delta = string(encoded)
		}
	}
	if delta != "" && !call.done {
		call.call.Arguments += delta
		events = append(events, Event{
			Type:  EventToolDelta,
			Index: call.call.Index,
			ID:    id,
			Name:  call.call.Name,
			Delta: delta,
		})
	}
	if stopped, ok := document["stop"].(bool); ok && stopped {
		events = append(events, decoder.finish(call)...)
	}
	return events
}

func (decoder *FrameDecoder) finish(call *toolCallState) []Event {
	if call == nil || call.done {
		return nil
	}
	call.done = true
	return []Event{{
		Type:      EventToolDone,
		Index:     call.call.Index,
		ID:        call.call.ID,
		Name:      call.call.Name,
		Arguments: call.call.Arguments,
	}}
}

// Flush 在流正常结束时收尾未收到 stop 的调用（不丢调用）。
func (decoder *FrameDecoder) Flush() []Event {
	if decoder == nil {
		return nil
	}
	events := make([]Event, 0, len(decoder.order))
	for _, call := range decoder.order {
		events = append(events, decoder.finish(call)...)
	}
	return events
}

// ToolCalls 返回已见到的工具调用快照。
func (decoder *FrameDecoder) ToolCalls() []ToolCall {
	if decoder == nil {
		return nil
	}
	calls := make([]ToolCall, 0, len(decoder.order))
	for _, call := range decoder.order {
		calls = append(calls, call.call)
	}
	return calls
}

func parsePayload(payload []byte) map[string]any {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	dec.UseNumber()
	var document map[string]any
	if err := dec.Decode(&document); err != nil || document == nil {
		return nil
	}
	return document
}

func textValue(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

func numberValue(value any) (float64, bool) {
	switch number := value.(type) {
	case json.Number:
		parsed, err := number.Float64()
		if err != nil {
			return 0, false
		}
		return parsed, true
	case float64:
		return number, true
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(number), 64)
		if err != nil {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}
