package codeassist

import (
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

func TestResponseDecoderPreservesTextToolIdentityUsageAndTerminal(t *testing.T) {
	t.Parallel()

	events := make([]inference.StreamEvent, 0, 16)
	decoder := newResponseDecoder(
		"claude-opus-4-6-thinking",
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	frames := [][]byte{
		[]byte(`{"response":{"candidates":[{"content":{"parts":[{"text":"hello "}]}}],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":2}}}`),
		[]byte(`{"response":{"candidates":[{"content":{"parts":[{"text":"world"},{"functionCall":{"id":"call_weather_1","name":"lookup_weather","args":{"city":"Shanghai"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":5}}}`),
	}
	for index, frame := range frames {
		if err := decoder.Apply(frame); err != nil {
			t.Fatalf("Apply(frame=%d) error = %v", index, err)
		}
	}
	if !decoder.Terminal() {
		t.Fatal("decoder missing terminal")
	}
	var text string
	var toolID, toolName string
	var toolArguments string
	var completed inference.ResponseCompletedEvent
	for _, event := range events {
		switch typed := event.(type) {
		case inference.TextDeltaEvent:
			text += typed.Delta()
		case inference.ToolCallStartedEvent:
			toolID, toolName = typed.CallID(), typed.Name()
		case inference.ToolArgumentsDeltaEvent:
			toolArguments += typed.Delta()
		case inference.ResponseCompletedEvent:
			completed = typed
		}
	}
	if text != "hello world" || toolID != "call_weather_1" ||
		toolName != "lookup_weather" || toolArguments != `{"city":"Shanghai"}` ||
		completed.StopReason() != inference.StopReasonToolUse ||
		completed.Usage().InputTokens() != 8 ||
		completed.Usage().OutputTokens() != 5 {
		t.Fatalf(
			"text=%q tool=%q/%q args=%q terminal=%#v",
			text, toolID, toolName, toolArguments, completed,
		)
	}
}

func TestResponseDecoderDropsThoughtsWithoutLeakingThemAsText(t *testing.T) {
	t.Parallel()

	var text string
	decoder := newResponseDecoder(
		"gemini-3-flash",
		func(event inference.StreamEvent) error {
			if delta, ok := event.(inference.TextDeltaEvent); ok {
				text += delta.Delta()
			}
			return nil
		},
	)
	frames := [][]byte{
		[]byte(`{"response":{"candidates":[{"content":{"parts":[{"thought":true,"text":"secret reasoning","thoughtSignature":"signature"}]}}]}}`),
		[]byte(`{"response":{"candidates":[{"content":{"parts":[{"text":"ok","thoughtSignature":"text-signature"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1,"thoughtsTokenCount":20}}}`),
	}
	for index, frame := range frames {
		if err := decoder.Apply(frame); err != nil {
			t.Fatalf("Apply(frame=%d) error = %v", index, err)
		}
	}
	if text != "ok" || !decoder.Terminal() {
		t.Fatalf("text=%q terminal=%v, want only the answer text", text, decoder.Terminal())
	}
}

func TestResponseDecoderAcceptsSignedFunctionCall(t *testing.T) {
	t.Parallel()

	var names []string
	decoder := newResponseDecoder(
		"claude-opus-4-6-thinking",
		func(event inference.StreamEvent) error {
			if started, ok := event.(inference.ToolCallStartedEvent); ok {
				names = append(names, started.Name())
			}
			return nil
		},
	)
	err := decoder.Apply([]byte(`{"response":{"candidates":[{"content":{"parts":[{"functionCall":{"id":"call_1","name":"lookup","args":{}},"thoughtSignature":"sig"}]},"finishReason":"STOP"}]}}`))
	if err != nil || len(names) != 1 || names[0] != "lookup" {
		t.Fatalf("Apply() err=%v names=%v", err, names)
	}
}
