package inferenceapi

import (
	"bytes"
	"net/http"
	"testing"
	"time"

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

// sseDeadlineWriter 同时支持即时刷新与写截止时间，模拟真实连接上的 SSE 响应。
type sseDeadlineWriter struct {
	header    http.Header
	body      bytes.Buffer
	deadlines []time.Time
}

func (writer *sseDeadlineWriter) Header() http.Header {
	if writer.header == nil {
		writer.header = http.Header{}
	}
	return writer.header
}

func (writer *sseDeadlineWriter) WriteHeader(int) {}

func (writer *sseDeadlineWriter) Write(payload []byte) (int, error) {
	return writer.body.Write(payload)
}

func (writer *sseDeadlineWriter) Flush() {}

func (writer *sseDeadlineWriter) SetWriteDeadline(deadline time.Time) error {
	writer.deadlines = append(writer.deadlines, deadline)
	return nil
}

// TestSSEStreamKeepsLongStreamAliveBeyondAbsoluteCap 锁定 G3 在 Canonical 流式入口
// 的行为：第 45 分钟仍在交付的事件必须拿到新的空闲窗口，而不是被请求开始时就定下的
// 10 分钟绝对截止时间切断。
func TestSSEStreamKeepsLongStreamAliveBeyondAbsoluteCap(t *testing.T) {
	t.Parallel()

	base := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	elapsed := time.Duration(0)
	writer := &sseDeadlineWriter{}
	stream, err := newSSEStream(
		writer,
		newStreamDeadline(writer, time.Minute, func() time.Time {
			return base.Add(elapsed)
		}),
	)
	if err != nil {
		t.Fatalf("newSSEStream() error = %v", err)
	}
	frame, err := clientprotocol.NewMarshaledDataEvent(
		[]byte(`{"object":"chat.completion.chunk"}`),
	)
	if err != nil {
		t.Fatalf("NewMarshaledDataEvent() error = %v", err)
	}

	elapsed = 45 * time.Minute
	if err := stream.Write([]clientprotocol.RenderedEvent{frame}); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	if len(writer.deadlines) != 1 {
		t.Fatalf("write deadlines = %d, want 1", len(writer.deadlines))
	}
	if want := base.Add(46 * time.Minute); !writer.deadlines[0].Equal(want) {
		t.Fatalf("deadline = %v, want %v", writer.deadlines[0], want)
	}
	if !stream.Committed() {
		t.Fatal("stream must be committed after the first batch")
	}
}
