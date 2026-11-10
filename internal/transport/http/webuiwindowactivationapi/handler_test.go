package webuiwindowactivationapi

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"
	"time"

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
	mux.Handle("GET "+Path+"/{provider}/{accountRef}/window-activation", handler)
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

func seedWindowState(t *testing.T, aiHomeDir string, config string, state string) {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(aiHomeDir, appstate.DatabaseFileName))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = db.Close() }()
	if config != "" {
		if _, err := db.Exec("INSERT OR REPLACE INTO app_kv VALUES (?, ?, 1)", keyPrefix+accountRef, config); err != nil {
			t.Fatalf("config: %v", err)
		}
	}
	if state != "" {
		if _, err := db.Exec("INSERT OR REPLACE INTO app_kv VALUES (?, ?, 1)", stateKeyPrefix+accountRef, state); err != nil {
			t.Fatalf("state: %v", err)
		}
	}
}

func getWindow(t *testing.T, handler http.Handler) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path+"/codex/"+accountRef+"/window-activation", nil))
	var payload map[string]any
	if recorder.Body.Len() > 0 {
		if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode %q: %v", recorder.Body.String(), err)
		}
	}
	return recorder, payload
}

func TestReadOpenWindow(t *testing.T) {
	aiHomeDir := seed(t)
	now := time.Now().UnixMilli()
	closeAt := now + 30*60*1000
	state := "{\"lastProbeAt\":" + strconv.FormatInt(now-1000, 10) +
		",\"lastOutcome\":\"ok\",\"windowAnchorAtMs\":" + strconv.FormatInt(closeAt-5*60*60*1000, 10) +
		",\"windowMinutes\":300,\"windowCloseAtMs\":" + strconv.FormatInt(closeAt, 10) +
		",\"windowSource\":\"probe\",\"windowObservedAtMs\":" + strconv.FormatInt(now-2000, 10) +
		",\"probeFailureCount\":2,\"lastDecisionAction\":\"probe\",\"lastDecisionReason\":\"window_closed\",\"lastDecisionAtMs\":" + strconv.FormatInt(now-3000, 10) + "}"
	seedWindowState(t, aiHomeDir, "{\"enabled\":true,\"intervalMs\":7200000,\"updatedAt\":1}", state)
	handler := newHandler(t, aiHomeDir)

	recorder, payload := getWindow(t, handler)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	setting := payload["setting"].(map[string]any)
	if setting["enabled"] != true || setting["intervalMs"] != float64(7200000) {
		t.Fatalf("setting = %#v", setting)
	}
	lastProbe := payload["lastProbe"].(map[string]any)
	if lastProbe["at"] != float64(now-1000) || lastProbe["outcome"] != "ok" {
		t.Fatalf("lastProbe = %#v", lastProbe)
	}
	window := payload["window"].(map[string]any)
	if window["kind"] != "open" || window["closeAtMs"] != float64(closeAt) || window["nextActionAtMs"] != float64(closeAt+probeGraceMs) {
		t.Fatalf("window = %#v", window)
	}
	if window["probeFailureCount"] != float64(2) || window["source"] != "probe" {
		t.Fatalf("window = %#v", window)
	}
	decision := window["lastDecision"].(map[string]any)
	if decision["action"] != "probe" || decision["reason"] != "window_closed" {
		t.Fatalf("decision = %#v", decision)
	}
}

func TestReadWindowKinds(t *testing.T) {
	now := time.Now().UnixMilli()
	cases := []struct {
		name  string
		state string
		kind  string
	}{
		{name: "closed", state: "{\"windowCloseAtMs\":" + strconv.FormatInt(now-1000, 10) + ",\"windowMinutes\":300}", kind: "closed"},
		{name: "absent", state: "{\"windowObservedAtMs\":" + strconv.FormatInt(now-1000, 10) + "}", kind: "absent"},
		{name: "unknown", state: "{}", kind: "unknown"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			aiHomeDir := seed(t)
			seedWindowState(t, aiHomeDir, "", testCase.state)
			handler := newHandler(t, aiHomeDir)
			_, payload := getWindow(t, handler)
			if payload["window"].(map[string]any)["kind"] != testCase.kind {
				t.Fatalf("window = %#v", payload["window"])
			}
		})
	}
}

func TestReadDefaultsAndErrors(t *testing.T) {
	aiHomeDir := seed(t)
	handler := newHandler(t, aiHomeDir)
	_, payload := getWindow(t, handler)
	setting := payload["setting"].(map[string]any)
	if setting["enabled"] != false || setting["intervalMs"] != nil {
		t.Fatalf("setting = %#v", setting)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path+"/codex/"+otherRef+"/window-activation", nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("unknown status = %d", recorder.Code)
	}
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path+"/claude/"+accountRef+"/window-activation", nil))
	if recorder.Code != http.StatusConflict {
		t.Fatalf("mismatch status = %d", recorder.Code)
	}
}
