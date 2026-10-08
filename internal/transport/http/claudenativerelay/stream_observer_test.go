package claudenativerelay

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

// TestCopyAndObserveNativeStreamNeverTruncatesWhenObserverStops 锁定 ZlibError 回归：
// 观察协程读不懂字节（例如超长行的压缩流）提前退出后，客户端仍须收到
// 完整的原始字节，而不是被 TeeReader 的 ErrClosedPipe 截断。
func TestCopyAndObserveNativeStreamNeverTruncatesWhenObserverStops(t *testing.T) {
	t.Parallel()

	// 超过 SSE 单行上限的无换行字节会让观察协程以 ErrInvalidEvent 提前退出。
	payload := bytes.Repeat([]byte{0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00}, 9*1024*1024/6+1)
	header := http.Header{"Content-Type": []string{"text/event-stream"}}
	recorder := httptest.NewRecorder()
	result, _ := copyAndObserveNativeStream(
		recorder,
		bytes.NewReader(payload),
		header,
		time.Now,
		inferenceapi.NewStreamDeadline(recorder),
	)
	if result.upstreamErr != nil || result.downstreamErr != nil {
		t.Fatalf("copy result = %#v", result)
	}
	if !bytes.Equal(recorder.Body.Bytes(), payload) {
		t.Fatalf("client received %d of %d bytes", recorder.Body.Len(), len(payload))
	}
}

// TestBuildUpstreamRequestAlwaysAsksForIdentityEncoding 验证客户端的压缩协商不会透传给
// Anthropic：流观察器只能分类明文 SSE。
func TestBuildUpstreamRequestAlwaysAsksForIdentityEncoding(t *testing.T) {
	t.Parallel()

	incoming := httptest.NewRequest(
		http.MethodPost,
		"/v1/messages?beta=true",
		strings.NewReader(`{"model":"claude-opus-5-5"}`),
	)
	incoming.Header.Set("Accept-Encoding", "gzip, deflate, br")
	upstream, err := buildUpstreamRequest(incoming, "synthetic-access-token")
	if err != nil {
		t.Fatalf("buildUpstreamRequest() error = %v", err)
	}
	if got := upstream.Header.Values("Accept-Encoding"); len(got) != 1 || got[0] != "identity" {
		t.Fatalf("upstream Accept-Encoding = %v, want [identity]", got)
	}
}

// deadlineTrackingWriter 记录每次写截止时间的取值，模拟支持 SetWriteDeadline 的连接。
type deadlineTrackingWriter struct {
	header    http.Header
	body      bytes.Buffer
	deadlines []time.Time
}

func (writer *deadlineTrackingWriter) Header() http.Header {
	if writer.header == nil {
		writer.header = http.Header{}
	}
	return writer.header
}

func (writer *deadlineTrackingWriter) WriteHeader(int) {}

func (writer *deadlineTrackingWriter) Write(payload []byte) (int, error) {
	return writer.body.Write(payload)
}

func (writer *deadlineTrackingWriter) Flush() {}

func (writer *deadlineTrackingWriter) SetWriteDeadline(deadline time.Time) error {
	writer.deadlines = append(writer.deadlines, deadline)
	return nil
}

// chunkReader 每次只交付一块，确保复制循环真的走了多轮。
type chunkReader struct {
	chunks [][]byte
	index  int
}

func (reader *chunkReader) Read(target []byte) (int, error) {
	if reader.index >= len(reader.chunks) {
		return 0, io.EOF
	}
	count := copy(target, reader.chunks[reader.index])
	reader.index++
	return count, nil
}

// TestCopyResponseBodyRefreshesWriteDeadlinePerChunk 锁定 G3：Relay 透传流的断开
// 判据必须是「持续没有数据」。旧实现在开始复制前只设一次 10 分钟绝对截止时间，
// 任何超过 10 分钟的原生 SSE 都会被硬切断。
func TestCopyResponseBodyRefreshesWriteDeadlinePerChunk(t *testing.T) {
	t.Parallel()

	writer := &deadlineTrackingWriter{}
	source := &chunkReader{chunks: [][]byte{[]byte("a"), []byte("b"), []byte("c")}}
	startedBefore := time.Now()
	result := copyResponseBody(
		writer,
		source,
		inferenceapi.NewStreamDeadline(writer),
	)
	if result.upstreamErr != nil || result.downstreamErr != nil {
		t.Fatalf("copyResponseBody() = %#v", result)
	}
	if writer.body.String() != "abc" {
		t.Fatalf("body = %q, want %q", writer.body.String(), "abc")
	}
	if len(writer.deadlines) != len(source.chunks) {
		t.Fatalf("write deadlines = %d, want one per chunk (%d)", len(writer.deadlines), len(source.chunks))
	}
	earliest := startedBefore.Add(inferenceapi.StreamIdleTimeout / 2)
	for index, deadline := range writer.deadlines {
		if deadline.Before(earliest) {
			t.Fatalf("deadline[%d] = %v, want at least %v", index, deadline, earliest)
		}
	}
}

// TestCopyResponseBodyToleratesConnectionsWithoutWriteDeadline 验证不支持写 deadline
// 的 ResponseWriter 不会让透传交付失败。
func TestCopyResponseBodyToleratesConnectionsWithoutWriteDeadline(t *testing.T) {
	t.Parallel()

	recorder := httptest.NewRecorder()
	result := copyResponseBody(
		recorder,
		strings.NewReader("payload"),
		inferenceapi.NewStreamDeadline(recorder),
	)
	if result.upstreamErr != nil || result.downstreamErr != nil {
		t.Fatalf("copyResponseBody() = %#v", result)
	}
	if recorder.Body.String() != "payload" {
		t.Fatalf("body = %q", recorder.Body.String())
	}
}
