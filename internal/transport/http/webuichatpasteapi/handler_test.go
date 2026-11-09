package webuichatpasteapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	_ "modernc.org/sqlite"
)

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

type fakeStore struct {
	raw   string
	found bool
	err   error
}

func (fake fakeStore) ReadServerConfig(context.Context) (string, bool, error) {
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

func decode(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode %q: %v", recorder.Body.String(), err)
	}
	return payload
}

func TestDefaultsWhenServerConfigMissing(t *testing.T) {
	recorder := httptest.NewRecorder()
	newHandler(t, fakeStore{}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	payload := decode(t, recorder)
	if payload["largePasteChars"] != float64(defaultLargePasteChars) || payload["custom"] != false {
		t.Fatalf("payload = %#v", payload)
	}
	limits := payload["limits"].(map[string]any)
	if limits["default"] != float64(defaultLargePasteChars) || limits["min"] != float64(minLargePasteChars) || limits["max"] != float64(maxLargePasteChars) {
		t.Fatalf("limits = %#v", limits)
	}
}

func TestCustomValueAndClamp(t *testing.T) {
	cases := []struct {
		name   string
		raw    string
		want   int
		custom bool
	}{
		{name: "stored", raw: "{\"largePasteChars\":60}", want: 60, custom: true},
		{name: "rounded", raw: "{\"largePasteChars\":60.6}", want: 61, custom: true},
		{name: "string", raw: "{\"largePasteChars\":\"80\"}", want: 80, custom: true},
		{name: "below min", raw: "{\"largePasteChars\":10}", want: minLargePasteChars, custom: true},
		{name: "above max", raw: "{\"largePasteChars\":999999}", want: maxLargePasteChars, custom: true},
		{name: "zero means default", raw: "{\"largePasteChars\":0}", want: defaultLargePasteChars, custom: false},
		{name: "null means default", raw: "{\"largePasteChars\":null}", want: defaultLargePasteChars, custom: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			newHandler(t, fakeStore{raw: testCase.raw, found: true}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
			payload := decode(t, recorder)
			if payload["largePasteChars"] != float64(testCase.want) || payload["custom"] != testCase.custom {
				t.Fatalf("payload = %#v", payload)
			}
		})
	}
}

func TestInvalidJSONIsRejected(t *testing.T) {
	recorder := httptest.NewRecorder()
	newHandler(t, fakeStore{raw: "{", found: true}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", recorder.Code)
	}
	if decode(t, recorder)["error"] != "chat_paste_settings_invalid" {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}

func TestReadFailureIsRejected(t *testing.T) {
	recorder := httptest.NewRecorder()
	newHandler(t, fakeStore{err: errors.New("boom")}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", recorder.Code)
	}
}

func TestAuthorizationAndMethod(t *testing.T) {
	handler, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{}, Store: fakeStore{}})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	recorder := httptest.NewRecorder()
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

func TestSourceReadsSameKeyAsNode(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, appstate.DatabaseFileName)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec("CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)"); err != nil {
		t.Fatalf("create app_kv: %v", err)
	}
	if _, err := db.Exec("INSERT INTO app_kv (key, value, updated_at) VALUES ('config:server', '{\"largePasteChars\":60,\"maxAttempts\":7}', 1)"); err != nil {
		t.Fatalf("insert: %v", err)
	}
	source, err := OpenSource(directory)
	if err != nil {
		t.Fatalf("OpenSource() error = %v", err)
	}
	raw, found, err := source.ReadServerConfig(context.Background())
	if err != nil || !found {
		t.Fatalf("ReadServerConfig() found=%v err=%v", found, err)
	}
	chars, custom, err := resolveLargePasteChars(raw, found)
	if err != nil || chars != 60 || !custom {
		t.Fatalf("resolve = %d/%v/%v", chars, custom, err)
	}
}
