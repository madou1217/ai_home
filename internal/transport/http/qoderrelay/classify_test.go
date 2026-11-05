package qoderrelay

import (
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

// nestedQueuePayload 复刻真机负载：三层 JSON 字符串，只有最内层有 isQueued。
func nestedQueuePayload(t *testing.T, retryAfter int) string {
	t.Helper()
	inner := `{"isQueued":true,"queueType":"model","retryAfterSeconds":` + strconv.Itoa(retryAfter) + `}`
	middle := `{"code":10605,"message":` + strconv.Quote(inner) + `}`
	return `{"code":"10605","message":` + strconv.Quote(middle) + `,"data":null}`
}

func TestDetectQueueUnwrapsNestedPayload(t *testing.T) {
	queue, ok := DetectQueue([]byte(nestedQueuePayload(t, 42)))
	if !ok {
		t.Fatal("expected nested qoder queue payload to be detected")
	}
	if queue.RetryAfterSeconds != 42 {
		t.Fatalf("RetryAfterSeconds = %d, want 42", queue.RetryAfterSeconds)
	}
	if queue.QueueType != "model" {
		t.Fatalf("QueueType = %q, want model", queue.QueueType)
	}
}

func TestDetectQueueAcceptsQueueFlags(t *testing.T) {
	cases := []string{
		`{"error":{"message":"RESOURCE_LIMIT: busy"}}`,
		`{"isQueued":true}`,
	}
	for _, payload := range cases {
		if _, ok := DetectQueue([]byte(payload)); !ok {
			t.Fatalf("expected %s to be detected as queue", payload)
		}
	}
}

func TestDetectQueueIgnoresNormalChunk(t *testing.T) {
	payload := `{"headers":{"model":"glm-5"},"body":"{\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}","statusCodeValue":200}`
	if _, ok := DetectQueue([]byte(payload)); ok {
		t.Fatal("normal chunk must not be treated as queue")
	}
}

func TestClassifyStreamFailureMapsQueueToOverloaded(t *testing.T) {
	classification, ok := ClassifyStreamFailure([]byte(nestedQueuePayload(t, 42)))
	if !ok {
		t.Fatal("expected queue event to be a business failure")
	}
	if classification.Kind() != runtimecore.FailureModelOverloaded {
		t.Fatalf("kind = %s, want model_overloaded", classification.Kind())
	}
	if classification.RetryAfter() != 42*time.Second {
		t.Fatalf("retryAfter = %s, want 42s", classification.RetryAfter())
	}
}

func TestClassifyStreamFailureMapsEnvelopeStatus(t *testing.T) {
	cases := []struct {
		status int
		kind   runtimecore.FailureKind
	}{
		{status: http.StatusTooManyRequests, kind: runtimecore.FailureRateLimited},
		{status: http.StatusServiceUnavailable, kind: runtimecore.FailureUpstreamUnavailable},
	}
	for _, testCase := range cases {
		event := `{"statusCodeValue":` + strconv.Itoa(testCase.status) + `,"body":""}`
		classification, ok := ClassifyStreamFailure([]byte(event))
		if !ok {
			t.Fatalf("status %d: expected business failure", testCase.status)
		}
		if classification.Kind() != testCase.kind {
			t.Fatalf("status %d: kind = %s, want %s", testCase.status, classification.Kind(), testCase.kind)
		}
	}
	// 4xx（除 429）证据不足，交回原有链路，避免误锁账号。
	if _, ok := ClassifyStreamFailure([]byte(`{"statusCodeValue":403,"body":""}`)); ok {
		t.Fatal("403 should stay with the stream transformer")
	}
}

func TestPresentBusinessFailureDeliversRetryAfter(t *testing.T) {
	provider := &Provider{}
	classification, ok := ClassifyStreamFailure([]byte(nestedQueuePayload(t, 42)))
	if !ok {
		t.Fatal("expected queue classification")
	}
	presentation := provider.PresentBusinessFailure(classification)
	if presentation.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", presentation.StatusCode)
	}
	if presentation.Code != queueFailureCode {
		t.Fatalf("code = %q, want %q", presentation.Code, queueFailureCode)
	}
	if got := presentation.Header.Get("Retry-After"); got != "42" {
		t.Fatalf("Retry-After = %q, want 42", got)
	}
	if got := presentation.Header.Get(queueIndicatorHeader); got != "1" {
		t.Fatalf("%s = %q, want 1", queueIndicatorHeader, got)
	}
	if !strings.Contains(presentation.Message, "排队") {
		t.Fatalf("message = %q", presentation.Message)
	}
}
