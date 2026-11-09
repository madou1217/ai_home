package webuisshapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

type fakeSessionStore struct {
	raw   string
	found bool
	err   error
}

func (fake fakeSessionStore) ReadWorkspaces(context.Context) (string, bool, error) {
	return fake.raw, fake.found, fake.err
}

func newSessionsHandler(t *testing.T, store WorkspaceStore, probe SessionProbe) http.Handler {
	t.Helper()
	handler, err := NewSessionsHandler(Dependencies{Authorizer: fakeAuthorizer{allowed: true}}, store, probe)
	if err != nil {
		t.Fatalf("NewSessionsHandler() error = %v", err)
	}
	return handler
}

func decodeSessions(t *testing.T, recorder *httptest.ResponseRecorder) []sessionView {
	t.Helper()
	var payload struct {
		OK       bool          `json:"ok"`
		Sessions []sessionView `json:"sessions"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode %q: %v", recorder.Body.String(), err)
	}
	if !payload.OK {
		t.Fatalf("ok = false: %s", recorder.Body.String())
	}
	return payload.Sessions
}

func TestSessionsProbeEachWorkspace(t *testing.T) {
	raw := `[{"id":"ws_0123456789abcdef"},{"id":"local-1"}]`
	probe := func(key string) string {
		if key == "remote-ws:ws_0123456789abcdef" {
			return "alive"
		}
		return "missing"
	}
	recorder := httptest.NewRecorder()
	newSessionsHandler(t, fakeSessionStore{raw: raw, found: true}, probe).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, WorkspaceSessionsPath, nil))
	sessions := decodeSessions(t, recorder)
	if len(sessions) != 2 {
		t.Fatalf("sessions = %#v", sessions)
	}
	if sessions[0].WorkspaceID != "ws_0123456789abcdef" || sessions[0].SessionKey != "remote-ws:ws_0123456789abcdef" || !sessions[0].Alive {
		t.Fatalf("first = %#v", sessions[0])
	}
	if sessions[1].WorkspaceID != "local-1" || sessions[1].SessionKey != "remote-ws:local-1" || sessions[1].Alive {
		t.Fatalf("second = %#v", sessions[1])
	}
}

func TestSessionsWithoutProbeAreNotAlive(t *testing.T) {
	recorder := httptest.NewRecorder()
	newSessionsHandler(t, fakeSessionStore{raw: `[{"id":"ws_0123456789abcdef"}]`, found: true}, nil).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, WorkspaceSessionsPath, nil))
	sessions := decodeSessions(t, recorder)
	if len(sessions) != 1 || sessions[0].Alive {
		t.Fatalf("sessions = %#v", sessions)
	}
}

func TestSessionsEmptyAndErrors(t *testing.T) {
	recorder := httptest.NewRecorder()
	newSessionsHandler(t, fakeSessionStore{}, nil).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, WorkspaceSessionsPath, nil))
	if len(decodeSessions(t, recorder)) != 0 {
		t.Fatalf("body = %s", recorder.Body.String())
	}
	recorder = httptest.NewRecorder()
	newSessionsHandler(t, fakeSessionStore{raw: "[", found: true}, nil).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, WorkspaceSessionsPath, nil))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("invalid json status = %d", recorder.Code)
	}
	recorder = httptest.NewRecorder()
	newSessionsHandler(t, fakeSessionStore{err: errors.New("boom")}, nil).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, WorkspaceSessionsPath, nil))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("read failure status = %d", recorder.Code)
	}
}

func TestSessionsAuthorizationAndMethod(t *testing.T) {
	handler, err := NewSessionsHandler(Dependencies{Authorizer: fakeAuthorizer{}}, fakeSessionStore{}, nil)
	if err != nil {
		t.Fatalf("NewSessionsHandler() error = %v", err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, WorkspaceSessionsPath, nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", recorder.Code)
	}
	recorder = httptest.NewRecorder()
	newSessionsHandler(t, fakeSessionStore{}, nil).ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, WorkspaceSessionsPath, nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d", recorder.Code)
	}
}
