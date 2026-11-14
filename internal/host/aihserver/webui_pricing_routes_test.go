package aihserver

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/transport/http/webuicontrolplanebootstrapapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuipricingapi"
)

type stubPricingAuthorizer struct{ allow bool }

func (a stubPricingAuthorizer) Authorized(*http.Request) bool { return a.allow }

type stubPricingHTTPClient struct {
	do func(*http.Request) (*http.Response, error)
}

func (c stubPricingHTTPClient) Do(req *http.Request) (*http.Response, error) {
	return c.do(req)
}

func TestBuildWebUIPricingRoutes_NoAuthorizerSkipsCleanly(t *testing.T) {
	routes, err := buildWebUIPricingRoutes(webuiRouteDependencies{})
	if err != nil {
		t.Fatalf("expected nil error when authorizer nil, got %v", err)
	}
	if len(routes) != 0 {
		t.Fatalf("expected 0 routes when authorizer nil, got %d", len(routes))
	}
}

func TestBuildWebUIPricingRoutes_ServeMuxAndEndToEnd(t *testing.T) {
	var mu sync.Mutex
	litePrice := 0.000003

	client := stubPricingHTTPClient{
		do: func(req *http.Request) (*http.Response, error) {
			mu.Lock()
			in := litePrice
			mu.Unlock()
			switch {
			case strings.Contains(req.URL.String(), "litellm"):
				raw, _ := json.Marshal(map[string]any{
					"anthropic/claude-sonnet-4": map[string]any{
						"litellm_provider":      "anthropic",
						"input_cost_per_token":  in,
						"output_cost_per_token": 0.000015,
					},
				})
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     http.Header{"Content-Type": []string{"application/json"}},
					Body:       io.NopCloser(bytes.NewReader(raw)),
				}, nil
			case strings.Contains(req.URL.String(), "openrouter"):
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     http.Header{"Content-Type": []string{"application/json"}},
					Body:       io.NopCloser(strings.NewReader(`{"data":[{"id":"openai/gpt-4.1","pricing":{"prompt":"0.000002","completion":"0.000008"}}]}`)),
				}, nil
			default:
				return &http.Response{
					StatusCode: http.StatusNotFound,
					Body:       io.NopCloser(strings.NewReader(`{}`)),
				}, nil
			}
		},
	}

	routes, err := buildWebUIPricingRoutesWithPorts(
		webuiRouteDependencies{
			Authorizer: stubPricingAuthorizer{allow: true},
			AIHomeDir:  t.TempDir(),
		},
		webuiPricingPorts{
			HTTPClient: client,
			Now:        func() time.Time { return time.Date(2026, 5, 16, 12, 0, 0, 0, time.UTC) },
		},
	)
	if err != nil {
		t.Fatalf("buildWebUIPricingRoutesWithPorts failed: %v", err)
	}
	if len(routes) != 7 {
		t.Fatalf("expected 7 pricing routes, got %d", len(routes))
	}

	mux := http.NewServeMux()
	// 验证与其它 /v1/management/webui/* 路由共用 ServeMux 无模式冲突。
	mux.Handle("GET "+webuicontrolplanebootstrapapi.Path, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	for _, r := range routes {
		mux.Handle(r.Pattern, r.Handler)
	}

	// Refresh all -> GET sources -> mutate -> refresh single -> reject -> merge-quotes -> status?detail=doctor
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, webuipricingapi.RefreshPath, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST refresh all failed: %d %s", rec.Code, rec.Body.String())
	}

	mu.Lock()
	litePrice = 0.000005
	mu.Unlock()

	rec = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, webuipricingapi.RefreshPath, strings.NewReader(`{"sourceId":"community:litellm"}`))
	req.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST refresh single failed: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, webuipricingapi.ReviewsPath+"?status=pending", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"claude-sonnet-4"`) {
		t.Fatalf("GET pending reviews unexpected: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, webuipricingapi.RejectPath, strings.NewReader(`{"sourceId":"community:litellm"}`))
	req.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"rejected":true`) {
		t.Fatalf("POST reject unexpected: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, webuipricingapi.StatusPath+"?detail=doctor", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"doctor":{`) {
		t.Fatalf("GET status?detail=doctor unexpected: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, webuipricingapi.MergeQuotesPath, strings.NewReader(`{"provider":"openai","model":"gpt-4.1","quotes":[{"provider":"openai","model":"gpt-4.1","input":2,"source":{"id":"p","kind":"vendor"}}]}`))
	req.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"contributions":1`) {
		t.Fatalf("POST merge-quotes unexpected: %d %s", rec.Code, rec.Body.String())
	}
}
