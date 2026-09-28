package claudenativerelay

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
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
