package usagestatsapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/core/usageledger"
)

type importAuthorizer struct{ allowed bool }

func (authorizer importAuthorizer) Authorized(*http.Request) bool { return authorizer.allowed }

type stubImportSource struct {
	imported int
	skipped  int
	events   []usageledger.ImportEvent
}

func (source *stubImportSource) ImportUsageEvents(_ context.Context, events []usageledger.ImportEvent) (int, int, error) {
	source.events = events
	return source.imported, source.skipped, nil
}

func newImportHandler(t *testing.T, allowed bool, source *stubImportSource) *ImportHandler {
	t.Helper()
	handler, err := NewImportHandler(importAuthorizer{allowed: allowed}, source)
	if err != nil {
		t.Fatalf("NewImportHandler() error = %v", err)
	}
	return handler
}

func TestImportHandlerRejectsUnauthorized(t *testing.T) {
	source := &stubImportSource{}
	request := httptest.NewRequest(http.MethodPost, ImportPath, strings.NewReader(`{"events":[]}`))
	response := httptest.NewRecorder()
	newImportHandler(t, false, source).ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.Code)
	}
}

func TestImportHandlerRejectsEmptyBody(t *testing.T) {
	source := &stubImportSource{}
	request := httptest.NewRequest(http.MethodPost, ImportPath, strings.NewReader(`{}`))
	response := httptest.NewRecorder()
	newImportHandler(t, true, source).ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", response.Code)
	}
}

func TestImportHandlerImportsEvents(t *testing.T) {
	source := &stubImportSource{imported: 1}
	body := `{"events":[{"source_key":"node:e1","account_ref":"acct_0123456789abcdef0123","provider":"codex","model":"gpt-6.1-sol","occurred_at_ms":1793948000000,"input_tokens":10,"output_tokens":5,"total_tokens":15}]}`
	request := httptest.NewRequest(http.MethodPost, ImportPath, strings.NewReader(body))
	response := httptest.NewRecorder()
	newImportHandler(t, true, source).ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var payload struct {
		Data struct {
			Imported int `json:"imported"`
			Skipped  int `json:"skipped"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if payload.Data.Imported != 1 {
		t.Fatalf("imported = %d, want 1", payload.Data.Imported)
	}
	if len(source.events) != 1 || source.events[0].SourceKey != "node:e1" {
		t.Fatalf("events 未透传: %+v", source.events)
	}
}
