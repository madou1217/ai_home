package webuicodexresetcreditapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/codexresetcredit"
)

type testAuthorizer struct{ allow bool }

func (a testAuthorizer) Authorized(_ *http.Request) bool { return a.allow }

type stubTransport struct {
	outcome string
	err     error
}

func (s *stubTransport) AssertOAuthAccount(_ context.Context, _ string) error { return nil }
func (s *stubTransport) ReadRateLimits(_ context.Context, _ string) (map[string]any, error) {
	return map[string]any{
		"rateLimitResetCredits": map[string]any{
			"availableCount": 1,
			"credits": []any{
				map[string]any{
					"id":        "crd-a",
					"resetType": "codexRateLimits",
					"status":    "available",
				},
			},
		},
	}, nil
}
func (s *stubTransport) ConsumeCredit(_ context.Context, _ string, _ string, _ string) (map[string]any, error) {
	if s.err != nil {
		return nil, s.err
	}
	return map[string]any{"outcome": s.outcome}, nil
}

func TestHandlerAuthListConsumeWatchAndReconcile(t *testing.T) {
	tr := &stubTransport{err: context.DeadlineExceeded}
	svc, err := codexresetcredit.NewService(codexresetcredit.ServiceDependencies{
		AIHomeDir: t.TempDir(),
		Transport: tr,
	})
	if err != nil {
		t.Fatalf("NewService failed: %v", err)
	}
	ref := "acct_0123456789abcdef0123"
	opID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

	unauth, _ := NewHandler(Dependencies{Authorizer: testAuthorizer{allow: false}, Service: svc})
	rec := httptest.NewRecorder()
	unauth.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, ListPatternPrefix+ref+"/reset-credits", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}

	h, err := NewHandler(Dependencies{
		Authorizer:    testAuthorizer{allow: true},
		Service:       svc,
		WatchInterval: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("NewHandler failed: %v", err)
	}

	// List
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, ListPatternPrefix+ref+"/reset-credits", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "no-store" || rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("missing security headers: %+v", rec.Header())
	}
	var listBody struct {
		OK               bool   `json:"ok"`
		InventoryVersion string `json:"inventoryVersion"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listBody); err != nil || !listBody.OK {
		t.Fatalf("invalid list body: %s", rec.Body.String())
	}

	// Consume missing payload -> 400
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, ListPatternPrefix+ref+"/reset-credits/consume", bytes.NewBufferString(`{}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}

	// Consume -> 202 unknown
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, ListPatternPrefix+ref+"/reset-credits/consume",
		bytes.NewBufferString(`{"operationId":"`+opID+`","inventoryVersion":"`+listBody.InventoryVersion+`"}`)))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d body=%s", rec.Code, rec.Body.String())
	}

	// Watch -> emits unknown and closes
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, ListPatternPrefix+ref+"/reset-operations/"+opID+"/watch", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"type":"operation"`) {
		t.Fatalf("unexpected SSE output: code=%d body=%s", rec.Code, rec.Body.String())
	}

	// Reconcile -> 200 succeeded
	tr.err = nil
	tr.outcome = "reset"
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, ListPatternPrefix+ref+"/reset-operations/"+opID+"/reconcile", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"status":"succeeded"`) {
		t.Fatalf("expected 200 succeeded, got %d body=%s", rec.Code, rec.Body.String())
	}
}
