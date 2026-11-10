package webuitoolkittargetsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

type fakeStore struct {
	raw   string
	found bool
	err   error
}

func (fake fakeStore) ReadConnections(context.Context) (string, bool, error) {
	return fake.raw, fake.found, fake.err
}

func newHandler(t *testing.T, store Store) http.Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{allowed: true}, Store: store})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func decodeTargets(t *testing.T, recorder *httptest.ResponseRecorder) []TargetView {
	t.Helper()
	var payload struct {
		OK      bool         `json:"ok"`
		Targets []TargetView `json:"targets"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode %q: %v", recorder.Body.String(), err)
	}
	if !payload.OK {
		t.Fatalf("ok = false: %s", recorder.Body.String())
	}
	return payload.Targets
}

func TestLocalOnlyWithoutConnections(t *testing.T) {
	recorder := httptest.NewRecorder()
	newHandler(t, fakeStore{}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	targets := decodeTargets(t, recorder)
	if len(targets) != 1 || targets[0].Kind != "local" || targets[0].ID != "local" || targets[0].Label != "本机（AIH Server）" {
		t.Fatalf("targets = %#v", targets)
	}
}

func TestSSHConnectionsAreMappedAndFiltered(t *testing.T) {
	raw := `[
		{"id":"conn_0123456789abcdef","label":"prod","host":"10.0.0.1","user":"dev"},
		{"id":"conn_fedcba9876543210","host":"10.0.0.2"},
		{"id":"not-a-conn","label":"skip","host":"10.0.0.3"}
	]`
	recorder := httptest.NewRecorder()
	newHandler(t, fakeStore{raw: raw, found: true}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	targets := decodeTargets(t, recorder)
	if len(targets) != 3 {
		t.Fatalf("targets = %#v", targets)
	}
	if targets[1].Kind != "ssh" || targets[1].ID != "ssh:conn_0123456789abcdef" || targets[1].Label != "prod" || targets[1].Host != "dev@10.0.0.1" {
		t.Fatalf("first ssh = %#v", targets[1])
	}
	if targets[2].ID != "ssh:conn_fedcba9876543210" || targets[2].Label != "10.0.0.2" || targets[2].Host != "10.0.0.2" {
		t.Fatalf("second ssh = %#v", targets[2])
	}
}

func TestInvalidAndErrors(t *testing.T) {
	recorder := httptest.NewRecorder()
	newHandler(t, fakeStore{raw: "[", found: true}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("invalid json status = %d", recorder.Code)
	}
	recorder = httptest.NewRecorder()
	newHandler(t, fakeStore{err: errors.New("boom")}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("read failure status = %d", recorder.Code)
	}
	handler, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{}, Store: fakeStore{}})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", recorder.Code)
	}
	recorder = httptest.NewRecorder()
	newHandler(t, fakeStore{}).ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path, nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d", recorder.Code)
	}
}
