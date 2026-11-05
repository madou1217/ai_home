package relaycore

import (
	"io"
	"net/http"
	"strings"
	"testing"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

func TestPeekFirstSSEEventHandlesCRLFAndMultilineData(t *testing.T) {
	body := "event: message\r\ndata: {\"a\":1}\r\ndata: {\"b\":2}\r\n\r\ndata: [DONE]\r\n\r\n"
	consumed, event, truncated, err := peekFirstSSEEvent(strings.NewReader(body), 4096)
	if err != nil || truncated {
		t.Fatalf("peek err=%v truncated=%v", err, truncated)
	}
	if got, want := string(event), "{\"a\":1}\n{\"b\":2}"; got != want {
		t.Fatalf("event = %q, want %q", got, want)
	}
	// 读前字节必须包含第二个事件：回放时一个字节都不能少。
	if !strings.Contains(string(consumed), "[DONE]") {
		t.Fatalf("consumed should include read-ahead bytes, got %q", consumed)
	}
}

func TestPeekFirstSSEEventReturnsRawWhenNoDataLines(t *testing.T) {
	payload := "{\"statusCodeValue\":429}\n\n"
	_, event, _, err := peekFirstSSEEvent(strings.NewReader(payload), 4096)
	if err != nil {
		t.Fatalf("peek: %v", err)
	}
	if got, want := string(event), "{\"statusCodeValue\":429}"; got != want {
		t.Fatalf("event = %q, want %q", got, want)
	}
}

func TestPeekFirstSSEEventReportsTruncation(t *testing.T) {
	payload := strings.Repeat("x", 2048)
	consumed, _, truncated, err := peekFirstSSEEvent(strings.NewReader(payload), 1024)
	if err != nil {
		t.Fatalf("peek: %v", err)
	}
	if !truncated {
		t.Fatal("expected truncated=true when the first event exceeds the limit")
	}
	if len(consumed) < 1024 {
		t.Fatalf("consumed = %d bytes, want at least the limit", len(consumed))
	}
}

// 首事件超过上限时放弃判定，但已读字节必须原样回放，否则下游会少一段内容。
func TestClassifyBusinessFailureSkipsOversizedEventButReplays(t *testing.T) {
	// 没有事件边界：预读会因超过上限而放弃判定。
	huge := "data: " + strings.Repeat("x", sharedfailure.MaxErrorPayloadBytes+16) + "\n"
	stub := &streamStub{
		BaseProvider:   NewBaseProvider("qoder", "https://example.invalid/v1"),
		classification: mustClassification(t, runtimecore.FailureRateLimited, 0),
	}
	response := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body:       io.NopCloser(strings.NewReader(huge)),
	}
	if _, ok := classifyBusinessFailure(stub, response); ok {
		t.Fatal("oversized first event must not be classified")
	}
	replayed, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read replayed body: %v", err)
	}
	if string(replayed) != huge {
		t.Fatalf("replayed %d bytes, want %d", len(replayed), len(huge))
	}
}
