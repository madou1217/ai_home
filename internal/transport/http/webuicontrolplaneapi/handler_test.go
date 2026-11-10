package webuicontrolplaneapi

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	_ "modernc.org/sqlite"
)

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

func newHandler(t *testing.T, aiHomeDir string) http.Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{allowed: true}, AIHomeDir: aiHomeDir})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle("GET "+Path+"/profiles", handler)
	mux.Handle("POST "+Path+"/profiles", handler)
	mux.Handle("POST "+Path+"/profiles/active", handler)
	mux.Handle("DELETE "+Path+"/profiles/{profileId}", handler)
	mux.Handle("GET "+Path+"/endpoints", handler)
	return mux
}

func seed(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(directory, appstate.DatabaseFileName))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec("CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)"); err != nil {
		t.Fatalf("schema: %v", err)
	}
	return directory
}

func doJSON(t *testing.T, handler http.Handler, method string, path string, payload any) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	var body []byte
	if payload != nil {
		body, _ = json.Marshal(payload)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(method, path, bytes.NewReader(body)))
	var decoded map[string]any
	if recorder.Body.Len() > 0 {
		if err := json.Unmarshal(recorder.Body.Bytes(), &decoded); err != nil {
			t.Fatalf("decode %q: %v", recorder.Body.String(), err)
		}
	}
	return recorder, decoded
}

func TestProfilesLifecycle(t *testing.T) {
	handler := newHandler(t, seed(t))

	recorder, payload := doJSON(t, handler, http.MethodGet, Path+"/profiles", nil)
	if recorder.Code != http.StatusOK || len(payload["profiles"].([]any)) != 0 || payload["activeProfileId"] != "" {
		t.Fatalf("empty store: %d %#v", recorder.Code, payload)
	}

	recorder, payload = doJSON(t, handler, http.MethodPost, Path+"/profiles", map[string]any{
		"profile": map[string]any{"endpoint": "control.example.com", "name": "prod"},
		"active":  true,
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("save status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	saved := payload["profile"].(map[string]any)
	if saved["endpoint"] != "https://control.example.com" || saved["id"] == "" || saved["state"] != "offline" {
		t.Fatalf("saved = %#v", saved)
	}
	if payload["activeProfileId"] != saved["id"] {
		t.Fatalf("active = %#v", payload)
	}

	recorder, payload = doJSON(t, handler, http.MethodPost, Path+"/profiles", map[string]any{
		"profile": map[string]any{"endpoint": "https://control.example.com/", "name": "prod-2"},
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("replace status = %d", recorder.Code)
	}
	if len(payload["profiles"].([]any)) != 1 || payload["profile"].(map[string]any)["name"] != "prod-2" {
		t.Fatalf("replace = %#v", payload)
	}

	recorder, payload = doJSON(t, handler, http.MethodPost, Path+"/profiles/active", map[string]any{"profileId": "missing"})
	if recorder.Code != http.StatusOK || payload["activeProfileId"] != "" {
		t.Fatalf("active missing = %d %#v", recorder.Code, payload)
	}

	id := saved["id"].(string)
	recorder, payload = doJSON(t, handler, http.MethodDelete, Path+"/profiles/"+id, nil)
	if recorder.Code != http.StatusOK || len(payload["profiles"].([]any)) != 0 || payload["activeProfileId"] != "" {
		t.Fatalf("delete = %d %#v", recorder.Code, payload)
	}
}

func TestProfilesValidationAndAuth(t *testing.T) {
	handler := newHandler(t, seed(t))
	recorder, _ := doJSON(t, handler, http.MethodPost, Path+"/profiles", map[string]any{"profile": map[string]any{"name": "no-endpoint"}})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("invalid profile status = %d", recorder.Code)
	}
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path+"/profiles", nil))
	unauthorized, _ := NewHandler(Dependencies{Authorizer: fakeAuthorizer{}, AIHomeDir: seed(t)})
	mux := http.NewServeMux()
	mux.Handle("GET "+Path+"/profiles", unauthorized)
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path+"/profiles", nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", recorder.Code)
	}
}

func TestEndpointHintsRequestAndLoopbackWarning(t *testing.T) {
	handler := newHandler(t, seed(t))
	recorder, payload := doJSON(t, handler, http.MethodGet, Path+"/endpoints?endpoint="+urlEncode("http://127.0.0.1:9527")+"&host=127.0.0.1&port=9527", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	hints := payload["endpoints"].([]any)
	if len(hints) == 0 || hints[0].(map[string]any)["source"] != "request" || hints[0].(map[string]any)["recommended"] != false {
		t.Fatalf("hints = %#v", hints)
	}
	warnings := payload["warnings"].([]any)
	if len(warnings) == 0 {
		t.Fatalf("warnings = %#v", warnings)
	}
}

func urlEncode(value string) string {
	return strings.NewReplacer(":", "%3A", "/", "%2F").Replace(value)
}
