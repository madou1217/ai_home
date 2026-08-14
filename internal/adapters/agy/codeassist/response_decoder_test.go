package codeassist

import (
	"errors"
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

func TestResponseDecoderRejectsUnexpectedThoughtAsPlainText(t *testing.T) {
	t.Parallel()

	decoder := newResponseDecoder(
		"claude-opus-4-6-thinking",
		func(inference.StreamEvent) error { return nil },
	)
	err := decoder.Apply([]byte(`{"response":{"candidates":[{"content":{"parts":[{"thought":true,"text":"secret reasoning","thoughtSignature":"signature"}]},"finishReason":"STOP"}]}}`))
	if !errors.Is(err, ErrInvalidUpstreamResponse) {
		t.Fatalf("Apply() error = %v, want ErrInvalidUpstreamResponse", err)
	}
}
