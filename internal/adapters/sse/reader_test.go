package sse

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
)

// TestReaderReassemblesNetworkChunksAndDataLines 验证任意网络分块、
// CRLF、注释和多行 data 不会改变 SSE 事件边界。
func TestReaderReassemblesNetworkChunksAndDataLines(t *testing.T) {
	t.Parallel()

	source := &chunkReader{
		chunks: [][]byte{
			[]byte(": keep-alive\r"),
			[]byte("\n"),
			[]byte("event: message_start\r\n"),
			[]byte("data: {\"type\":\"message_start\",\r\n"),
			[]byte("data: \"message\":{\"id\":\"msg_1\"}}\r\n\r\n"),
			[]byte("data: final"),
		},
	}
	reader, err := NewReader(source)
	if err != nil {
		t.Fatalf("NewReader() error = %v", err)
	}

	first, err := reader.Next()
	if err != nil {
		t.Fatalf("Next(first) error = %v", err)
	}
	if first.Type() != "message_start" ||
		string(first.Data()) != "{\"type\":\"message_start\",\n\"message\":{\"id\":\"msg_1\"}}" {
		t.Fatalf("first = type:%q data:%q", first.Type(), first.Data())
	}
	second, err := reader.Next()
	if err != nil || second.Type() != "" ||
		string(second.Data()) != "final" {
		t.Fatalf(
			"second = type:%q data:%q error=%v",
			second.Type(),
			second.Data(),
			err,
		)
	}
	if _, err := reader.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("Next(EOF) error = %v", err)
	}
}

// TestReaderRejectsOversizedLineAndMultilineEvent 验证单行和累计 data
// 都受固定上限约束。
func TestReaderRejectsOversizedLineAndMultilineEvent(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		"single-line": "data: " +
			strings.Repeat("x", maxLineBytes+1) + "\n\n",
		"multi-line": "data: " +
			strings.Repeat("x", MaxEventBytes/2) +
			"\ndata: " +
			strings.Repeat("y", MaxEventBytes/2) +
			"\n\n",
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			reader, err := NewReader(strings.NewReader(payload))
			if err != nil {
				t.Fatalf("NewReader() error = %v", err)
			}
			if _, err := reader.Next(); !errors.Is(err, ErrInvalidEvent) {
				t.Fatalf("Next() error = %v", err)
			}
		})
	}
}

// TestReaderRejectsNilSource 验证无来源不会在读取时触发 panic。
func TestReaderRejectsNilSource(t *testing.T) {
	t.Parallel()

	if _, err := NewReader(nil); !errors.Is(err, ErrInvalidSource) {
		t.Fatalf("NewReader(nil) error = %v", err)
	}
}

// TestReaderDispatchesFinalEventAtEOF 验证末尾没有空行时仍派发 data。
func TestReaderDispatchesFinalEventAtEOF(t *testing.T) {
	t.Parallel()

	reader, err := NewReader(bytes.NewBufferString("data: ping"))
	if err != nil {
		t.Fatalf("NewReader() error = %v", err)
	}
	event, err := reader.Next()
	if err != nil || string(event.Data()) != "ping" {
		t.Fatalf("Next() data=%q error=%v", event.Data(), err)
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
