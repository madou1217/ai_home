package imagesapi

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/images"
)

type allowAllAuthorizer struct{}

func (allowAllAuthorizer) Authorized(*http.Request) bool { return true }

type fixedProviderResolver struct{ provider string }

func (resolver fixedProviderResolver) ResolveProvider(context.Context, string, string) (string, error) {
	return resolver.provider, nil
}

type fixedAccounts struct{ accounts []images.Account }

func (source fixedAccounts) Candidates(
	_ context.Context,
	_ string,
	_ string,
	exclude []string,
) ([]images.Account, error) {
	blocked := map[string]bool{}
	for _, ref := range exclude {
		blocked[ref] = true
	}
	out := make([]images.Account, 0, len(source.accounts))
	for _, account := range source.accounts {
		if !blocked[account.AccountRef] {
			out = append(out, account)
		}
	}
	return out, nil
}

type failingDoer struct{ statusCode int }

func (doer failingDoer) Do(request *http.Request) (*http.Response, error) {
	return &http.Response{
		StatusCode: doer.statusCode,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(`{"error":{"message":"upstream exploded"}}`)),
		Request:    request,
	}, nil
}

type recordingOutcomes struct {
	mu        sync.Mutex
	successes []string
	failures  []string
	causes    []error
}

func (recorder *recordingOutcomes) RecordImageSuccess(_ context.Context, accountRef string, _ string, _ time.Time) {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	recorder.successes = append(recorder.successes, accountRef)
}

func (recorder *recordingOutcomes) RecordImageFailure(_ context.Context, accountRef string, model string, cause error) {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	recorder.failures = append(recorder.failures, accountRef+"|"+model)
	recorder.causes = append(recorder.causes, cause)
}

// 失败记账要真的从 HTTP 入口一路走到宿主接口：handler → images.Execute 的换号循环 →
// AttemptFailure 观察者 → RecordImageFailure。只测 images 包的话，中间这根线断了没人发现。
func TestHandlerReportsImageFailureToOutcomes(t *testing.T) {
	outcomes := &recordingOutcomes{}
	handler, err := NewHandler(Dependencies{
		Registry: images.NewRegistry("", "", nil),
		Accounts: fixedAccounts{accounts: []images.Account{{
			Provider:   "codex",
			AccountRef: "acct_fail",
			APIKey:     "sk-test",
			BaseURL:    "http://upstream.test",
			APIKeyMode: true,
		}}},
		Providers:  fixedProviderResolver{provider: "codex"},
		HTTP:       failingDoer{statusCode: http.StatusServiceUnavailable},
		Authorizer: allowAllAuthorizer{},
		Outcomes:   outcomes,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodPost, GenerationsPath,
		strings.NewReader(`{"model":"gpt-image-2","prompt":"a red dot","n":1}`))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("上游 503 应原样回给客户端，实际 %d: %s", recorder.Code, recorder.Body.String())
	}
	if len(outcomes.failures) != 1 {
		t.Fatalf("应上报一条失败，实际 %v", outcomes.failures)
	}
	if outcomes.failures[0] != "acct_fail|gpt-image-2" {
		t.Fatalf("失败账号/模型应是 acct_fail|gpt-image-2，实际 %q", outcomes.failures[0])
	}
	if len(outcomes.successes) != 0 {
		t.Fatalf("失败请求不能记成功: %v", outcomes.successes)
	}
	if cause, ok := images.AsError(outcomes.causes[0]); !ok || cause.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("上报的应是带 503 的 images.Error，实际 %v", outcomes.causes[0])
	}
}
