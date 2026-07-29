package clientprotocol

import (
	"errors"
	"strings"
	"testing"
)

// TestRenderedEventValidatesAndClonesData 验证 SSE 值对象拒绝换行事件名并深拷贝数据。
func TestRenderedEventValidatesAndClonesData(t *testing.T) {
	t.Parallel()

	source := []byte(`{"type":"message_start"}`)
	event, err := NewRenderedEvent("message_start", source)
	if err != nil {
		t.Fatalf("NewRenderedEvent() error = %v", err)
	}
	source[0] = '['
	first := event.Data()
	first[0] = '['
	if event.Name() != "message_start" ||
		string(event.Data()) != `{"type":"message_start"}` {
		t.Fatalf("RenderedEvent 被外部修改: name=%q data=%s", event.Name(), event.Data())
	}
	var output strings.Builder
	if err := event.WriteDataTo(&output); err != nil ||
		output.String() != `{"type":"message_start"}` {
		t.Fatalf("WriteDataTo() output=%q error=%v", output.String(), err)
	}

	for _, testCase := range []struct {
		name string
		data []byte
	}{
		{name: "", data: []byte(`{}`)},
		{name: "message\nstart", data: []byte(`{}`)},
		{name: " message_start", data: []byte(`{}`)},
		{name: "message:start", data: []byte(`{}`)},
		{name: "message_start", data: []byte(`not-json`)},
	} {
		if _, err := NewRenderedEvent(testCase.name, testCase.data); !errors.Is(
			err,
			ErrInvalidRenderedEvent,
		) {
			t.Fatalf("NewRenderedEvent(%q, %q) error = %v", testCase.name, testCase.data, err)
		}
	}
}

// TestNewMarshaledEventTakesOwnershipWithoutChangingOutput 验证热路径构造保持精确 JSON。
func TestNewMarshaledEventTakesOwnershipWithoutChangingOutput(t *testing.T) {
	t.Parallel()

	event, err := NewMarshaledEvent(
		"content_block_delta",
		[]byte(`{"type":"content_block_delta"}`),
	)
	if err != nil {
		t.Fatalf("NewMarshaledEvent() error = %v", err)
	}
	if string(event.Data()) != `{"type":"content_block_delta"}` {
		t.Fatalf("event data = %s", event.Data())
	}
	if _, err := NewMarshaledEvent(
		"content_block_delta",
		[]byte("{\n}"),
	); !errors.Is(err, ErrInvalidRenderedEvent) {
		t.Fatalf("NewMarshaledEvent(multiline) error = %v", err)
	}
}
