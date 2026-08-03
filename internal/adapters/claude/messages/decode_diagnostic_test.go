package messages

import (
	"errors"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

// TestDecodeDiagnosticErrorContainsOnlySafeShapes 验证诊断能定位结构，
// 同时不会回显工具参数、thinking、signature 或任意未知类型。
func TestDecodeDiagnosticErrorContainsOnlySafeShapes(t *testing.T) {
	t.Parallel()

	decoder, err := newResponseDecoder("claude-sonnet-5", func(event inference.StreamEvent) error {
		return nil
	})
	if err != nil {
		t.Fatalf("newResponseDecoder() error = %v", err)
	}
	diagnostic := newDecodeDiagnosticError(
		decoder,
		"content_block_delta",
		[]byte(`{"type":"content_block_delta","index":0,"content_block":{"type":"secret-type","input":{"secret":"must-not-log"}},"delta":{"type":"input_json_delta","partial_json":"must-not-log"},"thinking":"must-not-log","signature":"must-not-log"}`),
	)
	message := diagnostic.Error()
	if !errors.Is(diagnostic, ErrInvalidUpstreamResponse) ||
		!strings.Contains(message, "event=content_block_delta") ||
		!strings.Contains(message, "block=unknown") ||
		!strings.Contains(message, "delta=input_json_delta") ||
		!strings.Contains(message, "input=nonempty_object") ||
		!strings.Contains(message, "partial_json=nonempty") ||
		strings.Contains(message, "must-not-log") ||
		strings.Contains(message, "secret-type") {
		t.Fatalf("diagnostic = %q", message)
	}
}
