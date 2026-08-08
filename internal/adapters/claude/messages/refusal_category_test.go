package messages

import (
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

// TestDecoderCarriesRefusalCategory 验证上游 stop_details 进入 Canonical。
func TestDecoderCarriesRefusalCategory(t *testing.T) {
	t.Parallel()

	var captured inference.ResponseCompletedEvent
	decoder, err := newResponseDecoder(
		"claude-opus-4-6",
		func(event inference.StreamEvent) error {
			if typed, ok := event.(inference.ResponseCompletedEvent); ok {
				captured = typed
			}
			return nil
		},
		toolNameMapper{},
	)
	if err != nil {
		t.Fatalf("newResponseDecoder() error = %v", err)
	}
	payload := []byte(`{"id":"msg_1","type":"message","role":"assistant",` +
		`"model":"claude-opus-4-6","content":[{"type":"text","text":"no"}],` +
		`"stop_reason":"refusal","stop_sequence":null,` +
		`"stop_details":{"type":"refusal","category":"cyber"},` +
		`"usage":{"input_tokens":4,"output_tokens":1}}`)
	if err := decoder.DecodeMessage(payload); err != nil {
		t.Fatalf("DecodeMessage() error = %v", err)
	}
	if got := captured.RefusalCategory(); got != "cyber" {
		t.Fatalf("RefusalCategory() = %q, want cyber", got)
	}
	if captured.StopReason() != inference.StopReasonContentFilter {
		t.Fatalf("StopReason() = %q", captured.StopReason())
	}
}
