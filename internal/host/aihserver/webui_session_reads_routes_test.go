package aihserver

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

type stubSessionReadsAuth struct{}

func (stubSessionReadsAuth) Authorized(*http.Request) bool { return true }

func TestBuildWebUISessionReadsRoutes(t *testing.T) {
	emptyRoutes, err := buildWebUISessionReadsRoutes(webuiRouteDependencies{})
	if err != nil || len(emptyRoutes) != 0 {
		t.Fatalf("expected nil/empty without dependencies, got routes=%v err=%v", emptyRoutes, err)
	}

	home := t.TempDir()
	aiHome := filepath.Join(home, ".ai_home")
	if err := os.MkdirAll(aiHome, 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(aiHome, "app-state.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		CREATE TABLE model_usage_records (id INTEGER PRIMARY KEY, provider TEXT, session_id TEXT, model TEXT, source_kind TEXT, timestamp_ms INTEGER);
		INSERT INTO model_usage_records(provider, session_id, model, source_kind, timestamp_ms) VALUES ('codex','cx-1','gpt-5.4','manual_proxy',1234);
	`); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()

	routes, err := buildWebUISessionReadsRoutes(webuiRouteDependencies{
		Authorizer:  stubSessionReadsAuth{},
		HostHomeDir: home,
		AIHomeDir:   aiHome,
	})
	if err != nil {
		t.Fatalf("buildWebUISessionReadsRoutes error = %v", err)
	}
	if len(routes) != 1 {
		t.Fatalf("len(routes) = %d want 1", len(routes))
	}

	mux := http.NewServeMux()
	for _, route := range routes {
		mux.Handle(route.Pattern, route.Handler)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/management/webui/sessions/codex/cx-1/model", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var payload struct {
		OK    bool   `json:"ok"`
		Model string `json:"model"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.OK || payload.Model != "gpt-5.4" {
		t.Fatalf("payload = %+v, want gpt-5.4", payload)
	}
}
