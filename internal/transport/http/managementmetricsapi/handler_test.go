package managementmetricsapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type testAuthorizer bool

func (authorizer testAuthorizer) Authorized(*http.Request) bool { return bool(authorizer) }

func TestHandlerReturnsObservedGoMetrics(t *testing.T) {
	handler, err := NewHandler(testAuthorizer(true), testSource{snapshot: Snapshot{
		TotalRequests: 5, TotalSuccess: 4, TotalFailures: 1, TotalTimeouts: 1,
		SuccessRate: .8, TimeoutRate: .2, RouteCounts: map[string]uint64{"/v1/models": 5},
	}})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, Path, nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	body := response.Body.String()
	for _, fragment := range []string{`"total_requests":5`, `"total_success":4`, `"total_failures":1`, `"total_timeouts":1`, `"success_rate":0.8`, `"/v1/models":5`} {
		if !strings.Contains(body, fragment) {
			t.Fatalf("body missing %s: %s", fragment, body)
		}
	}
}

type testSource struct{ snapshot Snapshot }

func (source testSource) Snapshot() Snapshot { return source.snapshot }
