package relaycore

import (
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

// streamStub 是只实现流式业务失败判定的最小 Provider。
type streamStub struct {
	BaseProvider
	classification sharedfailure.Classification
	seen           []byte
	presentation   BusinessFailurePresentation
	presents       bool
}

func (stub *streamStub) ClassifyStreamBusinessFailure(
	_ int,
	_ http.Header,
	firstEvent []byte,
) (sharedfailure.Classification, bool) {
	stub.seen = append([]byte(nil), firstEvent...)
	return stub.classification, true
}

func (stub *streamStub) PresentBusinessFailure(
	_ sharedfailure.Classification,
) BusinessFailurePresentation {
	if !stub.presents {
		return BusinessFailurePresentation{}
	}
	return stub.presentation
}

func mustClassification(t *testing.T, kind runtimecore.FailureKind, retryAfter time.Duration) sharedfailure.Classification {
	t.Helper()
	classification, err := sharedfailure.NewClassification(kind, retryAfter)
	if err == nil {
		return classification
	}
	// 额度类失败只接受带作用域的硬阻塞分类。
	blocking, blockErr := sharedfailure.NewBlockingClassification(
		kind,
		runtimecore.BlockScopeAccount,
	)
	if blockErr != nil {
		t.Fatalf("NewClassification(%s): %v / %v", kind, err, blockErr)
	}
	return blocking
}

// 预读首事件后必须把「已读字节」全部回放，否则下游 transformer 会少一段内容。
func TestClassifyBusinessFailureReplaysStreamBody(t *testing.T) {
	body := "data: {\"statusCodeValue\":429,\"body\":\"\"}\n\n" +
		"data: {\"body\":\"{\\\"choices\\\":[]}\"}\n\n" +
		"data: [DONE]\n\n"
	stub := &streamStub{
		BaseProvider:   NewBaseProvider("qoder", "https://example.invalid/v1"),
		classification: mustClassification(t, runtimecore.FailureRateLimited, 0),
	}
	response := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream; charset=utf-8"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
	classification, ok := classifyBusinessFailure(stub, response)
	if !ok {
		t.Fatal("expected the first event to be classified as a business failure")
	}
	if classification.Kind() != runtimecore.FailureRateLimited {
		t.Fatalf("kind = %s, want rate_limited", classification.Kind())
	}
	if !strings.Contains(string(stub.seen), "statusCodeValue") {
		t.Fatalf("classifier saw %q, want the first event payload", stub.seen)
	}
	replayed, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read replayed body: %v", err)
	}
	if string(replayed) != body {
		t.Fatalf("replayed body = %q, want %q", replayed, body)
	}
}

// Provider 没声明呈现时，relaycore 仍要把容量/限流类失败交付成 429 而不是 502。
func TestBusinessFailurePresentationDefaults(t *testing.T) {
	provider := NewBaseProvider("zcode", "https://example.invalid/v1")
	cases := []struct {
		name string
		kind runtimecore.FailureKind
		want int
	}{
		{name: "quota", kind: runtimecore.FailureQuotaExhausted, want: http.StatusTooManyRequests},
		{name: "rate limit", kind: runtimecore.FailureRateLimited, want: http.StatusTooManyRequests},
		{name: "overloaded", kind: runtimecore.FailureModelOverloaded, want: http.StatusTooManyRequests},
		{name: "credential", kind: runtimecore.FailureCredentialRejected, want: http.StatusBadGateway},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			presentation := businessFailurePresentation(
				provider,
				mustClassification(t, testCase.kind, 0),
			)
			if presentation.StatusCode != testCase.want {
				t.Fatalf("status = %d, want %d", presentation.StatusCode, testCase.want)
			}
			if presentation.Code != "upstream_business_failure" {
				t.Fatalf("code = %q", presentation.Code)
			}
		})
	}
}

// Provider 的呈现只补自己声明的字段，其余仍由 relaycore 兜底。
func TestBusinessFailurePresentationUsesProviderOverride(t *testing.T) {
	stub := &streamStub{
		BaseProvider: NewBaseProvider("qoder", "https://example.invalid/v1"),
		presents:     true,
		presentation: BusinessFailurePresentation{
			StatusCode: http.StatusTooManyRequests,
			Header:     http.Header{"Retry-After": []string{"7"}},
		},
	}
	presentation := businessFailurePresentation(
		stub,
		mustClassification(t, runtimecore.FailureModelOverloaded, 7*time.Second),
	)
	if presentation.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("status = %d", presentation.StatusCode)
	}
	if got := presentation.Header.Get("Retry-After"); got != "7" {
		t.Fatalf("Retry-After = %q", got)
	}
	if presentation.Code != "upstream_business_failure" || presentation.Message == "" {
		t.Fatalf("fallback code/message not applied: %+v", presentation)
	}
}
