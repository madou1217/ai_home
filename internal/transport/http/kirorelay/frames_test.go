package kirorelay

import (
	"encoding/json"
	"testing"
)

func eventFrame(eventType, payload string) Frame {
	return Frame{
		Headers: map[string]string{":message-type": "event", ":event-type": eventType},
		Payload: []byte(payload),
	}
}

func eventFrameJSON(t *testing.T, eventType string, body map[string]any) Frame {
	t.Helper()
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return eventFrame(eventType, string(payload))
}

func TestFrameDecoderTextAndConversation(t *testing.T) {
	decoder := NewFrameDecoder()
	events := decoder.Decode(eventFrameJSON(t, "initial-response", map[string]any{"conversationId": "c1"}))
	if len(events) != 1 || events[0].Type != EventConversation || events[0].ID != "c1" {
		t.Fatalf("events = %#v", events)
	}
	events = decoder.Decode(eventFrameJSON(t, "assistantResponseEvent", map[string]any{"content": "Hel"}))
	events = append(events, decoder.Decode(eventFrameJSON(t, "assistantResponseEvent", map[string]any{"content": "lo"}))...)
	if len(events) != 2 || events[0].Text != "Hel" || events[1].Text != "lo" {
		t.Fatalf("events = %#v", events)
	}
	if events := decoder.Decode(eventFrame("unknownEvent", `{"x":1}`)); len(events) != 0 {
		t.Fatalf("未知事件应忽略: %#v", events)
	}
	if events := decoder.Decode(eventFrame("assistantResponseEvent", "not-json")); len(events) != 0 {
		t.Fatalf("非法 JSON 应忽略: %#v", events)
	}
}

func TestFrameDecoderToolUseLifecycle(t *testing.T) {
	decoder := NewFrameDecoder()
	events := decoder.Decode(eventFrameJSON(t, "toolUseEvent", map[string]any{
		"toolUseId": "t1", "name": "read", "input": `{"pa`,
	}))
	if len(events) != 2 || events[0].Type != EventToolStart || events[1].Type != EventToolDelta {
		t.Fatalf("首帧应给出 start+delta: %#v", events)
	}
	events = decoder.Decode(eventFrameJSON(t, "toolUseEvent", map[string]any{
		"toolUseId": "t1", "input": `th":"a"}`, "stop": true,
	}))
	if len(events) != 2 || events[1].Type != EventToolDone {
		t.Fatalf("结束帧应给出 delta+done: %#v", events)
	}
	if events[1].Arguments != `{"path":"a"}` {
		t.Fatalf("累计参数 = %q", events[1].Arguments)
	}
	calls := decoder.ToolCalls()
	if len(calls) != 1 || calls[0].Index != 0 || calls[0].Name != "read" {
		t.Fatalf("calls = %#v", calls)
	}
	decoder.Decode(eventFrameJSON(t, "toolUseEvent", map[string]any{
		"toolUseId": "t2", "name": "write", "input": "{}",
	}))
	flushed := decoder.Flush()
	if len(flushed) != 1 || flushed[0].Type != EventToolDone || flushed[0].Index != 1 {
		t.Fatalf("flush = %#v", flushed)
	}
}

func TestFrameDecoderMeteringAndContext(t *testing.T) {
	decoder := NewFrameDecoder()
	events := decoder.Decode(eventFrameJSON(t, "meteringEvent", map[string]any{"unit": "credit", "usage": 1.5}))
	if len(events) != 1 || events[0].Type != EventMetering || events[0].Usage != 1.5 || events[0].Unit != "credit" {
		t.Fatalf("metering = %#v", events)
	}
	events = decoder.Decode(eventFrameJSON(t, "meteringEvent", map[string]any{"usage": 2}))
	if events[0].Unit != "credit" {
		t.Fatalf("缺省 unit 应为 credit: %#v", events)
	}
	events = decoder.Decode(eventFrameJSON(t, "contextUsageEvent", map[string]any{"contextUsagePercentage": 12.5}))
	if len(events) != 1 || events[0].Type != EventContextUsage || events[0].Percentage != 12.5 {
		t.Fatalf("context usage = %#v", events)
	}
}

func TestFrameDecoderReasoning(t *testing.T) {
	events := NewFrameDecoder().Decode(eventFrameJSON(t, "reasoningContentEvent", map[string]any{"text": "thinking..."}))
	if len(events) != 1 || events[0].Type != EventThinking || events[0].Text != "thinking..." {
		t.Fatalf("thinking = %#v", events)
	}
}
