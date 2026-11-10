package webuiwindowactivationapi

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	_ "modernc.org/sqlite"
)

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

const (
	accountRef = "acct_0123456789abcdef0123"
	otherRef   = "acct_fedcba98765432100123"
)

func seed(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(directory, appstate.DatabaseFileName))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = db.Close() }()
	for _, statement := range []string{
		"CREATE TABLE account_refs (account_ref TEXT PRIMARY KEY, provider TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
		"CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("schema: %v", err)
		}
	}
	if _, err := db.Exec("INSERT INTO account_refs VALUES (?, 'codex', 1, 1)", accountRef); err != nil {
		t.Fatalf("insert account: %v", err)
	}
	return directory
}

func newHandler(t *testing.T, aiHomeDir string) http.Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{allowed: true}, AIHomeDir: aiHomeDir})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle("POST "+Path+"/{provider}/{accountRef}/window-activation", handler)
	return mux
}

func post(t *testing.T, handler http.Handler, path string, payload any) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body)))
	var decoded map[string]any
	if recorder.Body.Len() > 0 {
		if err := json.Unmarshal(recorder.Body.Bytes(), &decoded); err != nil {
			t.Fatalf("decode %q: %v", recorder.Body.String(), err)
		}
	}
	return recorder, decoded
}

func readStored(t *testing.T, aiHomeDir string) map[string]any {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(aiHomeDir, appstate.DatabaseFileName))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = db.Close() }()
	var raw string
	if err := db.QueryRow("SELECT value FROM app_kv WHERE key = ?", keyPrefix+accountRef).Scan(&raw); err != nil {
		t.Fatalf("read kv: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		t.Fatalf("decode kv: %v", err)
	}
	return decoded
}

func TestWriteEnabledWithInterval(t *testing.T) {
	aiHomeDir := seed(t)
	handler := newHandler(t, aiHomeDir)
	recorder, payload := post(t, handler, Path+"/codex/"+accountRef+"/window-activation", map[string]any{
		"enabled": true, "intervalMs": 7200000, "minIntervalMs": 3600000,
	})
	if recorder.Code != http.StatusOK || payload["ok"] != true {
		t.Fatalf("status=%d payload=%#v", recorder.Code, payload)
	}
	stored := readStored(t, aiHomeDir)
	if stored["enabled"] != true || stored["intervalMs"] != float64(7200000) || stored["updatedAt"] == float64(0) {
		t.Fatalf("stored = %#v", stored)
	}
}

func TestWriteClearsIntervalAndDisables(t *testing.T) {
	aiHomeDir := seed(t)
	handler := newHandler(t, aiHomeDir)
	recorder, _ := post(t, handler, Path+"/codex/"+accountRef+"/window-activation", map[string]any{
		"enabled": false, "intervalMs": nil,
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	stored := readStored(t, aiHomeDir)
	if stored["enabled"] != false || stored["intervalMs"] != nil {
		t.Fatalf("stored = %#v", stored)
	}
}

func TestWriteValidation(t *testing.T) {
	aiHomeDir := seed(t)
	handler := newHandler(t, aiHomeDir)
	path := Path + "/codex/" + accountRef + "/window-activation"

	recorder, payload := post(t, handler, path, map[string]any{"enabled": true, "intervalMs": 1000})
	if recorder.Code != http.StatusBadRequest || payload["error"] != "invalid_interval_ms" || payload["minIntervalMs"] != float64(minIntervalMs) {
		t.Fatalf("status=%d payload=%#v", recorder.Code, payload)
	}
	recorder, payload = post(t, handler, path, map[string]any{"enabled": true, "intervalMs": 400 * 24 * 60 * 60 * 1000})
	if recorder.Code != http.StatusBadRequest || payload["error"] != "invalid_interval_ms" {
		t.Fatalf("max status=%d payload=%#v", recorder.Code, payload)
	}
	recorder, payload = post(t, handler, path, []int{1, 2})
	if recorder.Code != http.StatusBadRequest || payload["error"] != "invalid_request_body" {
		t.Fatalf("array status=%d payload=%#v", recorder.Code, payload)
	}
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, path, bytes.NewReader([]byte("{"))))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("invalid json status = %d", recorder.Code)
	}
}

func TestWriteAccountErrors(t *testing.T) {
	aiHomeDir := seed(t)
	handler := newHandler(t, aiHomeDir)
	recorder, _ := post(t, handler, Path+"/codex/"+otherRef+"/window-activation", map[string]any{"enabled": true})
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("unknown status = %d", recorder.Code)
	}
	recorder, _ = post(t, handler, Path+"/claude/"+accountRef+"/window-activation", map[string]any{"enabled": true})
	if recorder.Code != http.StatusConflict {
		t.Fatalf("mismatch status = %d", recorder.Code)
	}
}

func TestRequiresAuthorization(t *testing.T) {
	handler, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{}, AIHomeDir: seed(t)})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle("POST "+Path+"/{provider}/{accountRef}/window-activation", handler)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path+"/codex/"+accountRef+"/window-activation", bytes.NewReader([]byte("{}"))))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", recorder.Code)
	}
}
