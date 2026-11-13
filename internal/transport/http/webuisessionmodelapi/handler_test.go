package webuisessionmodelapi

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

type stubAuth bool

func (a stubAuth) Authorized(*http.Request) bool { return bool(a) }

func TestSessionModelOpenCodeUsageRecordsAndAuth(t *testing.T) {
	home := t.TempDir()
	aiHome := filepath.Join(home, ".ai_home")
	if err := os.MkdirAll(aiHome, 0o755); err != nil {
		t.Fatal(err)
	}

	appDB, err := sql.Open("sqlite", filepath.Join(aiHome, "app-state.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := appDB.Exec(`
		CREATE TABLE model_usage_records (id INTEGER PRIMARY KEY, provider TEXT, session_id TEXT, model TEXT, source_kind TEXT, timestamp_ms INTEGER);
		INSERT INTO model_usage_records(provider, session_id, model, source_kind, timestamp_ms) VALUES
			('opencode', 'oc-1', 'wrong-proxy-model', 'manual_proxy', 9000),
			('claude', 'c-1', 'claude-sonnet-4-6', 'manual_proxy', 5000),
			('workbuddy', 'wb-1', 'hunyuan-t1', 'manual_proxy', 4000),
			('workbuddy', 'wb-1', 'ignored-native', 'native_session_done', 8000);
	`); err != nil {
		t.Fatal(err)
	}
	_ = appDB.Close()

	ocDir := filepath.Join(home, ".local", "share", "opencode")
	if err := os.MkdirAll(ocDir, 0o755); err != nil {
		t.Fatal(err)
	}
	ocDB, err := sql.Open("sqlite", filepath.Join(ocDir, "opencode.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ocDB.Exec(`
		CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, model TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, parent_id TEXT);
		INSERT INTO session_v2 VALUES ('oc-1', '/tmp', 'OC', 'anthropic/claude-opus-4-1', 100, 200, NULL, NULL);
	`); err != nil {
		t.Fatal(err)
	}
	_ = ocDB.Close()

	unauthHandler, err := NewHandler(Dependencies{Authorizer: stubAuth(false), HostHomeDir: home, AIHomeDir: aiHome})
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	unauthHandler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/management/webui/sessions/claude/c-1/model", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauth status = %d want 401", rec.Code)
	}

	handler, err := NewHandler(Dependencies{Authorizer: stubAuth(true), HostHomeDir: home, AIHomeDir: aiHome})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.Handle("GET "+Path, handler)

	for _, tc := range []struct {
		provider string
		sid      string
		want     string
	}{
		{"opencode", "oc-1", "anthropic/claude-opus-4-1"},
		{"claude", "c-1", "claude-sonnet-4-6"},
		{"workbuddy", "wb-1", "hunyuan-t1"},
		{"gemini", "missing", ""},
	} {
		r := httptest.NewRecorder()
		mux.ServeHTTP(r, httptest.NewRequest(http.MethodGet, "/v1/management/webui/sessions/"+tc.provider+"/"+tc.sid+"/model", nil))
		if r.Code != http.StatusOK {
			t.Fatalf("%s/%s status = %d body=%s", tc.provider, tc.sid, r.Code, r.Body.String())
		}
		var body responseView
		if err := json.Unmarshal(r.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if !body.OK || body.Provider != tc.provider || body.SessionID != tc.sid || body.Model != tc.want {
			t.Fatalf("%s/%s body = %+v, want model=%q", tc.provider, tc.sid, body, tc.want)
		}
	}
}
