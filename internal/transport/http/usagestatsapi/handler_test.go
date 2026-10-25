package usagestatsapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/usageledger"
)

type testAuthorizer bool

func (a testAuthorizer) Authorized(*http.Request) bool { return bool(a) }

type testSource struct {
	stats usageledger.Stats
	query usageledger.Query
}

func (source *testSource) QueryUsageStats(_ context.Context, query usageledger.Query) (usageledger.Stats, error) {
	source.query = query
	return source.stats, nil
}

func TestHandlerReturnsStatsWithExplicitRangeAndFilters(t *testing.T) {
	source := &testSource{stats: usageledger.Stats{TotalCalls: 2, TotalSessions: 1, InputTokens: 12, OutputTokens: 8, TotalTokens: 20}}
	handler, err := NewHandler(testAuthorizer(true), source)
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, Path+"?from=2026-10-01&to=2026-10-02&provider=codex&model=gpt-6.1-sol", nil)
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if source.query.Provider != "codex" || source.query.Model != "gpt-6.1-sol" || source.query.From.Location() != time.UTC || source.query.To.Location() != time.UTC {
		t.Fatalf("query = %#v", source.query)
	}
	if !strings.Contains(recorder.Body.String(), `"total_calls":2`) || !strings.Contains(recorder.Body.String(), `"total_tokens":20`) {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}

func TestHandlerRejectsUnauthorizedAndInvalidRange(t *testing.T) {
	source := &testSource{}
	handler, err := NewHandler(testAuthorizer(false), source)
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", recorder.Code)
	}
	handler, _ = NewHandler(testAuthorizer(true), source)
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path+"?from=bad&to=bad", nil))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("invalid range status = %d", recorder.Code)
	}
}
