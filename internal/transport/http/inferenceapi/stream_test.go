package inferenceapi

import (
	"bytes"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
)

// TestWriteSSEFramePreservesNamedAndDataOnlyContracts 验证 Responses/Messages
// 继续携带 event 字段，而 Chat Completions 只输出 data 字段。
func TestWriteSSEFramePreservesNamedAndDataOnlyContracts(t *testing.T) {
	t.Parallel()

	named, err := clientprotocol.NewRenderedEvent(
		"response.created",
		[]byte(`{"type":"response.created"}`),
	)
	if err != nil {
		t.Fatalf("NewRenderedEvent() error = %v", err)
	}
	dataOnly, err := clientprotocol.NewMarshaledDataEvent(
		[]byte(`{"object":"chat.completion.chunk"}`),
	)
	if err != nil {
		t.Fatalf("NewMarshaledDataEvent() error = %v", err)
	}

	var output bytes.Buffer
	if err := writeSSEFrame(&output, named); err != nil {
		t.Fatalf("writeSSEFrame(named) error = %v", err)
	}
	if err := writeSSEFrame(&output, dataOnly); err != nil {
		t.Fatalf("writeSSEFrame(data-only) error = %v", err)
	}
	want := "event: response.created\n" +
		"data: {\"type\":\"response.created\"}\n\n" +
		"data: {\"object\":\"chat.completion.chunk\"}\n\n"
	if output.String() != want {
		t.Fatalf("SSE output = %q, want %q", output.String(), want)
	}
}
