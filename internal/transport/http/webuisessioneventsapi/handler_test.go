package webuisessioneventsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type stubAuthorizer bool

func (authorizer stubAuthorizer) Authorized(*http.Request) bool { return bool(authorizer) }

type fakeReader struct {
	requests []EventRequest
	result   EventResult
	err      error
}

func (reader *fakeReader) ReadEvents(_ context.Context, request EventRequest) (EventResult, error) {
	reader.requests = append(reader.requests, request)
	return reader.result, reader.err
}

func newTestHandler(t *testing.T, dependencies Dependencies) http.Handler {
	t.Helper()
	handler, err := NewHandler(dependencies)
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func serveEvents(handler http.Handler, target string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, target, nil)
	mux := http.NewServeMux()
	mux.Handle("GET "+Path, handler)
	mux.ServeHTTP(recorder, request)
	return recorder
}

func TestHandlerRejectsUnauthorized(t *testing.T) {
	reader := &fakeReader{}
	handler := newTestHandler(t, Dependencies{Authorizer: stubAuthorizer(false), Reader: reader})
	recorder := serveEvents(handler, "/v1/management/webui/sessions/codex/s1/events?cursor=0")
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
	if len(reader.requests) != 0 {
		t.Fatalf("未授权请求不应触达 reader")
	}
}

func TestHandlerRejectsInvalidSessionID(t *testing.T) {
	reader := &fakeReader{}
	handler := newTestHandler(t, Dependencies{Authorizer: stubAuthorizer(true), Reader: reader})
	recorder := serveEvents(handler, "/v1/management/webui/sessions/codex/..%2Fsecret/events")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (%s)", recorder.Code, recorder.Body.String())
	}
}

func TestHandlerDelegatesAndReturnsNodeShape(t *testing.T) {
	reader := &fakeReader{result: EventResult{
		Events: []Event{{
			Kind:      "assistant_text",
			Timestamp: "2026-11-12T10:00:00.000Z",
			Text:      "hi",
			Model:     "gpt-5.1-codex",
		}},
		Cursor:               42,
		RequiresSnapshot:     boolPointer(false),
		HasAssistantToolCall: true,
	}}
	handler := newTestHandler(t, Dependencies{Authorizer: stubAuthorizer(true), Reader: reader})
	recorder := serveEvents(handler, "/v1/management/webui/sessions/CODEX/s-1/events?cursor=7&projectDirName=ignored")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if len(reader.requests) != 1 {
		t.Fatalf("reader 调用次数 = %d, want 1", len(reader.requests))
	}
	request := reader.requests[0]
	if request.Provider != "codex" || request.SessionID != "s-1" || request.Cursor != 7 || request.ProjectDirName != "ignored" {
		t.Fatalf("request = %+v", request)
	}
	var body map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是合法 JSON: %v", err)
	}
	if body["ok"] != true || body["cursor"] != float64(42) || body["hasAssistantToolCall"] != true {
		t.Fatalf("body = %#v", body)
	}
	if _, exists := body["requiresSnapshot"]; !exists {
		t.Fatalf("requiresSnapshot=false 必须显式返回: %#v", body)
	}
	events, _ := body["events"].([]any)
	if len(events) != 1 {
		t.Fatalf("events = %#v", body["events"])
	}
	event, _ := events[0].(map[string]any)
	if event["type"] != "assistant_text" || event["text"] != "hi" || event["model"] != "gpt-5.1-codex" {
		t.Fatalf("event = %#v", event)
	}
	if _, exists := event["content"]; exists {
		t.Fatalf("assistant_text 不应带 content: %#v", event)
	}
}

func TestHandlerOmitsRequiresSnapshotWhenReaderLeavesItNil(t *testing.T) {
	reader := &fakeReader{result: EventResult{Events: []Event{}, Cursor: 10}}
	handler := newTestHandler(t, Dependencies{Authorizer: stubAuthorizer(true), Reader: reader})
	recorder := serveEvents(handler, "/v1/management/webui/sessions/codex/s-1/events")
	var body map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是合法 JSON: %v", err)
	}
	if _, exists := body["requiresSnapshot"]; exists {
		t.Fatalf("nil 必须省略 requiresSnapshot: %#v", body)
	}
}

func TestHandlerUnsupportedProvider(t *testing.T) {
	handler := newTestHandler(t, Dependencies{
		Authorizer:  stubAuthorizer(true),
		HostHomeDir: t.TempDir(),
	})
	recorder := serveEvents(handler, "/v1/management/webui/sessions/claude/s-1/events")
	if recorder.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是合法 JSON: %v", err)
	}
	if body["error"] != ErrorCodeUnsupportedProvider {
		t.Fatalf("body = %#v", body)
	}
}

func TestHandlerSessionNotFound(t *testing.T) {
	reader := &fakeReader{err: ErrSessionNotFound}
	handler := newTestHandler(t, Dependencies{Authorizer: stubAuthorizer(true), Reader: reader})
	recorder := serveEvents(handler, "/v1/management/webui/sessions/codex/s-1/events")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是合法 JSON: %v", err)
	}
	if body["error"] != "session_not_found" {
		t.Fatalf("body = %#v", body)
	}
}

func TestHandlerReaderFailure(t *testing.T) {
	reader := &fakeReader{err: errors.New("boom")}
	handler := newTestHandler(t, Dependencies{Authorizer: stubAuthorizer(true), Reader: reader})
	recorder := serveEvents(handler, "/v1/management/webui/sessions/codex/s-1/events")
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "get_session_events_failed") {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}

func TestParseCursor(t *testing.T) {
	cases := map[string]int64{
		"":    0,
		"-5":  0,
		"0":   0,
		"12":  12,
		"1.5": 0,
		"abc": 0,
	}
	for input, want := range cases {
		if got := parseCursor(input); got != want {
			t.Fatalf("parseCursor(%q) = %d, want %d", input, got, want)
		}
	}
}

func TestNewHandlerRequiresDependencies(t *testing.T) {
	if _, err := NewHandler(Dependencies{Authorizer: stubAuthorizer(true)}); err == nil {
		t.Fatalf("缺少 HostHomeDir/Reader 时应失败")
	}
	if _, err := NewHandler(Dependencies{HostHomeDir: t.TempDir()}); err == nil {
		t.Fatalf("缺少 Authorizer 时应失败")
	}
}
