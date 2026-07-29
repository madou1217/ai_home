package responses

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
)

// TestSSEReaderReassemblesNetworkChunksAndDataLines 验证网络分块、
// CRLF、注释和多行 data 不会改变事件边界。
func TestSSEReaderReassemblesNetworkChunksAndDataLines(t *testing.T) {
	t.Parallel()

	source := &chunkReader{
		chunks: [][]byte{
			[]byte(": keep-alive\r"),
			[]byte("\n"),
			[]byte("event: response.created\r\n"),
			[]byte("data: {\"type\":\"response.created\",\r\n"),
			[]byte("data: \"response\":{\"id\":\"resp_1\"}}\r\n\r\n"),
			[]byte("data: [DO"),
			[]byte("NE]\n\n"),
		},
	}
	reader := newSSEReader(source)

	first, err := reader.Next()
	if err != nil {
		t.Fatalf("Next(first) error = %v", err)
	}
	if first.eventType != "response.created" ||
		string(first.data) != "{\"type\":\"response.created\",\n\"response\":{\"id\":\"resp_1\"}}" {
		t.Fatalf("first = type:%q data:%q", first.eventType, first.data)
	}
	second, err := reader.Next()
	if err != nil {
		t.Fatalf("Next(second) error = %v", err)
	}
	if second.eventType != "" || string(second.data) != "[DONE]" {
		t.Fatalf("second = type:%q data:%q", second.eventType, second.data)
	}
	if _, err := reader.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("Next(EOF) error = %v", err)
	}
}

// TestSSEReaderRejectsOversizedEvent 验证单行和完整事件共用固定上限。
func TestSSEReaderRejectsOversizedEvent(t *testing.T) {
	t.Parallel()

	source := strings.NewReader("data: " +
		strings.Repeat("x", maxSSEEventBytes+1) +
		"\n\n")
	_, err := newSSEReader(source).Next()
	if !errors.Is(err, ErrInvalidUpstreamResponse) {
		t.Fatalf("Next() error = %v", err)
	}
}

// TestSSEReaderDispatchesFinalEventAtEOF 验证末尾没有空行时仍返回已完成 data。
func TestSSEReaderDispatchesFinalEventAtEOF(t *testing.T) {
	t.Parallel()

	reader := newSSEReader(bytes.NewBufferString("data: {\"type\":\"ping\"}"))
	event, err := reader.Next()
	if err != nil || string(event.data) != `{"type":"ping"}` {
		t.Fatalf("Next() event=%q error=%v", event.data, err)
	}
}

// chunkReader 模拟任意网络 Read 分块。
type chunkReader struct {
	chunks [][]byte
}

// Read 每次只返回预设的一个网络分块。
func (reader *chunkReader) Read(destination []byte) (int, error) {
	if len(reader.chunks) == 0 {
		return 0, io.EOF
	}
	chunk := reader.chunks[0]
	reader.chunks = reader.chunks[1:]
	count := copy(destination, chunk)
	if count < len(chunk) {
		reader.chunks = append(
			[][]byte{append([]byte(nil), chunk[count:]...)},
			reader.chunks...,
		)
	}
	return count, nil
}
