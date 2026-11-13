package webuipricingapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/pricingcatalog"
)

type stubAuthorizer struct {
	authorized bool
}

func (s stubAuthorizer) Authorized(*http.Request) bool {
	return s.authorized
}

type stubHTTPClient struct {
	do func(*http.Request) (*http.Response, error)
}

func (s stubHTTPClient) Do(req *http.Request) (*http.Response, error) {
	return s.do(req)
}

func newTestHandler(t *testing.T, authorized bool, client pricingcatalog.HTTPClient) http.Handler {
	t.Helper()
	store, err := pricingcatalog.NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}
	svc, err := pricingcatalog.NewService(pricingcatalog.ServiceDependencies{
		Store:      store,
		HTTPClient: client,
		Now:        func() time.Time { return time.Date(2026, 5, 15, 10, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatalf("NewService failed: %v", err)
	}
	h, err := NewHandler(Dependencies{
		Authorizer: stubAuthorizer{authorized: authorized},
		Service:    svc,
	})
	if err != nil {
		t.Fatalf("NewHandler failed: %v", err)
	}
	return h
}

func decodeBodyMap(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("unmarshal response failed (%s): %v", rec.Body.String(), err)
	}
	return out
}

func TestNewHandlerRejectsInvalidDependencies(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("expected ErrInvalidDependencies, got %v", err)
	}
}

func TestHandlerAuthAndMethodEnforcement(t *testing.T) {
	unauth := newTestHandler(t, false, nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, SourcesPath, nil)
	unauth.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized || rec.Header().Get("WWW-Authenticate") != "Bearer" {
		t.Fatalf("expected 401 Bearer before method check, got %d (%v)", rec.Code, rec.Header())
	}

	auth := newTestHandler(t, true, nil)
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, SourcesPath, nil)
	auth.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("expected 405 Allow GET, got %d (%v)", rec.Code, rec.Header())
	}
}

func TestPricingHTTPWorkflowRefreshReviewStatusAndMergeQuotes(t *testing.T) {
	var mu sync.Mutex
	litellmInput := 0.000003

	client := stubHTTPClient{
		do: func(req *http.Request) (*http.Response, error) {
			mu.Lock()
			inRate := litellmInput
			mu.Unlock()
			switch {
			case strings.Contains(req.URL.String(), "litellm"):
				body := map[string]any{
					"anthropic/claude-sonnet-4": map[string]any{
						"litellm_provider":     "anthropic",
						"input_cost_per_token": inRate,
						"output_cost_per_token": 0.000015,
					},
				}
				raw, _ := json.Marshal(body)
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     http.Header{"Content-Type": []string{"application/json"}},
					Body:       io.NopCloser(bytes.NewReader(raw)),
				}, nil
			case strings.Contains(req.URL.String(), "openrouter"):
				raw := `{"data":[{"id":"openai/gpt-4.1","pricing":{"prompt":"0.000002","completion":"0.000008"}}]}`
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     http.Header{"Content-Type": []string{"application/json"}},
					Body:       io.NopCloser(strings.NewReader(raw)),
				}, nil
			default:
				return &http.Response{
					StatusCode: http.StatusNotFound,
					Body:       io.NopCloser(strings.NewReader(`{}`)),
				}, nil
			}
		},
	}

	h := newTestHandler(t, true, client)

	// 1. Unknown community source -> 400
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, RefreshPath, strings.NewReader(`{"sourceId":"community:unknown"}`))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for unknown community source, got %d: %s", rec.Code, rec.Body.String())
	}

	// 2. Empty POST /refresh runs all community sources (initial auto-applied)
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, RefreshPath, nil)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on empty refresh, got %d: %s", rec.Code, rec.Body.String())
	}
	payload := decodeBodyMap(t, rec)
	if payload["ok"] != true || payload["pluginRun"] == nil {
		t.Fatalf("unexpected refresh all response: %+v", payload)
	}

	// 3. Mutate upstream price and refresh single source -> queued for review
	mu.Lock()
	litellmInput = 0.000004
	mu.Unlock()

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, RefreshPath, strings.NewReader(`{"sourceId":"community:litellm"}`))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on single refresh, got %d: %s", rec.Code, rec.Body.String())
	}
	single := decodeBodyMap(t, rec)
	if single["applied"] != false || single["reviewRequired"] != true {
		t.Fatalf("expected reviewRequired=true on changed price, got %+v", single)
	}

	// 4. GET /sources and GET /reviews?status=pending
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, SourcesPath, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /sources failed: %d", rec.Code)
	}
	sourcesPayload := decodeBodyMap(t, rec)
	if len(sourcesPayload["reviews"].([]any)) != 1 {
		t.Fatalf("expected 1 pending review in /sources, got %+v", sourcesPayload)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, ReviewsPath+"?status=pending", nil))
	if rec.Code != http.StatusOK || len(decodeBodyMap(t, rec)["reviews"].([]any)) != 1 {
		t.Fatalf("GET /reviews?status=pending failed: %d %s", rec.Code, rec.Body.String())
	}

	// 5. GET /status?detail=doctor
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, StatusPath+"?detail=doctor", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /status?detail=doctor failed: %d", rec.Code)
	}
	statusBody := decodeBodyMap(t, rec)
	if statusBody["doctor"] == nil || statusBody["pendingReviews"].(float64) != 1 {
		t.Fatalf("unexpected /status?detail=doctor body: %+v", statusBody)
	}

	// 6. Approve then second approve -> 404
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, ApprovePath, strings.NewReader(`{"sourceId":"community:litellm"}`))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || decodeBodyMap(t, rec)["ok"] != true {
		t.Fatalf("POST /approve failed: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, ApprovePath, strings.NewReader(`{"sourceId":"community:litellm"}`))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 on second approve, got %d: %s", rec.Code, rec.Body.String())
	}

	// 7. Reject invalid sourceId -> 400; valid -> 200
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, RejectPath, strings.NewReader(`{"sourceId":"bad/id"}`))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for bad sourceId reject, got %d", rec.Code)
	}

	// 8. POST /merge-quotes validates required fields and merges raw plugin quotes
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, MergeQuotesPath, strings.NewReader(`{"provider":"","model":"gpt-4.1","quotes":[]}`))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on missing provider, got %d", rec.Code)
	}

	mergeBody := `{
		"provider": "openai",
		"model": "gpt-4.1",
		"quotes": [
			{"provider": "openai", "model": "gpt-4.1", "input": 2.0, "output": 8.0, "source": {"id": "plugin:a", "kind": "vendor"}}
		]
	}`
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, MergeQuotesPath, strings.NewReader(mergeBody))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /merge-quotes failed: %d %s", rec.Code, rec.Body.String())
	}
	mergeOut := decodeBodyMap(t, rec)
	quoteMap := mergeOut["quote"].(map[string]any)
	if quoteMap["input"].(float64) != 2.0 || mergeOut["contributions"].(float64) != 1 {
		t.Fatalf("unexpected merge-quotes output: %+v", mergeOut)
	}
}

func TestPricingHTTPErrorMapping502And415(t *testing.T) {
	failClient := stubHTTPClient{
		do: func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusServiceUnavailable,
				Status:     "503 Service Unavailable",
				Body:       io.NopCloser(strings.NewReader("upstream down")),
			}, nil
		},
	}
	h := newTestHandler(t, true, failClient)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, RefreshPath, strings.NewReader(`{"sourceId":"community:litellm"}`))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502 on community upstream failure, got %d: %s", rec.Code, rec.Body.String())
	}
	if decodeBodyMap(t, rec)["error"] != "community_pricing_refresh_failed" {
		t.Fatalf("unexpected error code: %s", rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, ApprovePath, strings.NewReader(`{"sourceId":"community:litellm"}`))
	req.Header.Set("Content-Type", "text/plain")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("expected 415 on text/plain approve, got %d: %s", rec.Code, rec.Body.String())
	}
}
