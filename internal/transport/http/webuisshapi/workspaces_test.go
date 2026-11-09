package webuisshapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

type fakeWorkspaceStore struct {
	raw   string
	found bool
	err   error
}

func (fake fakeWorkspaceStore) ReadWorkspaces(context.Context) (string, bool, error) {
	return fake.raw, fake.found, fake.err
}

func newWorkspacesHandler(t *testing.T, store WorkspaceStore) http.Handler {
	t.Helper()
	handler, err := NewWorkspacesHandler(Dependencies{Authorizer: fakeAuthorizer{allowed: true}}, store, "/tmp/ai-home")
	if err != nil {
		t.Fatalf("NewWorkspacesHandler() error = %v", err)
	}
	return handler
}

func decodeWorkspaces(t *testing.T, recorder *httptest.ResponseRecorder) []map[string]any {
	t.Helper()
	var payload struct {
		OK         bool             `json:"ok"`
		Workspaces []map[string]any `json:"workspaces"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode %q: %v", recorder.Body.String(), err)
	}
	if !payload.OK {
		t.Fatalf("ok = false: %s", recorder.Body.String())
	}
	return payload.Workspaces
}

func TestWorkspacesMissingIsEmptyList(t *testing.T) {
	recorder := httptest.NewRecorder()
	newWorkspacesHandler(t, fakeWorkspaceStore{}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, WorkspacesPath, nil))
	if len(decodeWorkspaces(t, recorder)) != 0 {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}

func TestRemoteWorkspaceGetsProjectPath(t *testing.T) {
	raw := `[{"id":"ws_0123456789abcdef","label":"prod","remoteRoot":"/srv/app"},{"id":"local-1"}]`
	recorder := httptest.NewRecorder()
	newWorkspacesHandler(t, fakeWorkspaceStore{raw: raw, found: true}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, WorkspacesPath, nil))
	workspaces := decodeWorkspaces(t, recorder)
	if len(workspaces) != 2 {
		t.Fatalf("workspaces = %#v", workspaces)
	}
	if workspaces[0]["projectPath"] != "/tmp/ai-home/run/remote-workspaces/ws_0123456789abcdef" {
		t.Fatalf("projectPath = %#v", workspaces[0]["projectPath"])
	}
	if _, exists := workspaces[1]["projectPath"]; exists {
		t.Fatalf("local workspace must not get projectPath: %#v", workspaces[1])
	}
	if workspaces[0]["label"] != "prod" || workspaces[0]["remoteRoot"] != "/srv/app" {
		t.Fatalf("fields lost: %#v", workspaces[0])
	}
}

func TestWorkspacesNonArrayIsEmptyList(t *testing.T) {
	recorder := httptest.NewRecorder()
	newWorkspacesHandler(t, fakeWorkspaceStore{raw: `{"not":"array"}`, found: true}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, WorkspacesPath, nil))
	if len(decodeWorkspaces(t, recorder)) != 0 {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}

func TestWorkspacesErrorsAndAuth(t *testing.T) {
	recorder := httptest.NewRecorder()
	newWorkspacesHandler(t, fakeWorkspaceStore{raw: "[", found: true}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, WorkspacesPath, nil))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("invalid json status = %d", recorder.Code)
	}
	recorder = httptest.NewRecorder()
	newWorkspacesHandler(t, fakeWorkspaceStore{err: errors.New("boom")}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, WorkspacesPath, nil))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("read failure status = %d", recorder.Code)
	}
	handler, err := NewWorkspacesHandler(Dependencies{Authorizer: fakeAuthorizer{}}, fakeWorkspaceStore{}, "/tmp/ai-home")
	if err != nil {
		t.Fatalf("NewWorkspacesHandler() error = %v", err)
	}
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, WorkspacesPath, nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", recorder.Code)
	}
}
