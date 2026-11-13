package webuiprojectsapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/webuiremoteworkspace"
)

type staticAuthorizer struct{ allow bool }

func (a staticAuthorizer) Authorized(*http.Request) bool { return a.allow }

func TestAppStateProjectsOverlayRemoteAndHidden(t *testing.T) {
	ctx := context.Background()
	hostHome := t.TempDir()
	aiHome := filepath.Join(hostHome, ".ai_home")
	if err := os.MkdirAll(aiHome, 0o700); err != nil {
		t.Fatalf("mkdir aiHome: %v", err)
	}
	manualDir := filepath.Join(t.TempDir(), "custom-repo")
	hiddenDir := filepath.Join(t.TempDir(), "hidden-repo")
	if err := os.MkdirAll(manualDir, 0o755); err != nil {
		t.Fatalf("mkdir manual: %v", err)
	}
	if err := os.MkdirAll(hiddenDir, 0o755); err != nil {
		t.Fatalf("mkdir hidden: %v", err)
	}

	// Put a Claude hashed project dir for manualDir WITHOUT trustedFolders entry!
	sanitized := strings.NewReplacer("/", "-", "_", "-").Replace(manualDir)
	claudeProjDir := filepath.Join(hostHome, ".claude", "projects", sanitized)
	if err := os.MkdirAll(claudeProjDir, 0o755); err != nil {
		t.Fatalf("mkdir claude proj: %v", err)
	}
	sessionLine := `{"type":"user","timestamp":"2026-01-03T10:00:00Z","message":{"content":"你好手动项目"}}`
	if err := os.WriteFile(filepath.Join(claudeProjDir, "sess-1.jsonl"), []byte(sessionLine+"\n"), 0o600); err != nil {
		t.Fatalf("write claude session: %v", err)
	}

	dbPath, err := appstate.DatabasePath(aiHome)
	if err != nil {
		t.Fatalf("DatabasePath: %v", err)
	}
	statePayload, _ := json.Marshal(map[string]any{
		"projects": []map[string]any{
			{"path": manualDir, "name": "My Custom", "addedAt": 1700000000000},
			{"path": hiddenDir, "name": "Hidden", "addedAt": 1700000001000},
		},
		"hiddenPaths": []string{hiddenDir},
	})
	if err := appstate.WriteKV(ctx, dbPath, webuiProjectsKey, string(statePayload), 100); err != nil {
		t.Fatalf("WriteKV projects: %v", err)
	}
	if err := appstate.WriteKV(ctx, dbPath, "ssh_connections", `[{"id":"c1","label":"devbox","host":"10.1.2.3","user":"alice"}]`, 100); err != nil {
		t.Fatalf("WriteKV conns: %v", err)
	}
	if err := appstate.WriteKV(ctx, dbPath, "ssh_workspaces", `[{"id":"ws_0123456789abcdef","connectionId":"c1","remoteRoot":"/srv/work","label":"Remote Work","createdAt":1800000000000}]`, 100); err != nil {
		t.Fatalf("WriteKV workspaces: %v", err)
	}
	// Put an unregistered orphan shadow directory that must be filtered out even if Claude recorded a session in it.
	orphanShadow := filepath.Join(aiHome, "run", "remote-workspaces", "ws_fedcba9876543210")
	if err := os.MkdirAll(orphanShadow, 0o700); err != nil {
		t.Fatalf("mkdir orphan shadow: %v", err)
	}

	handler, err := NewHandler(Dependencies{
		Authorizer: staticAuthorizer{allow: true},
		HostHomeDir: hostHome,
		AiHomeDir:   aiHome,
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, Path, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET %s status = %d body=%s", Path, rec.Code, rec.Body.String())
	}
	var resp struct {
		OK       bool          `json:"ok"`
		Projects []projectView `json:"projects"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(resp.Projects) != 2 {
		t.Fatalf("expected 2 projects (remote + manual, excluding hidden & orphan), got %d: %+v", len(resp.Projects), resp.Projects)
	}
	// Remote has AddedAt 1800000000000 vs claude session 2026-01-03 (1767434400000) -> Remote comes first.
	if resp.Projects[0].Remote == nil || resp.Projects[0].Remote.WorkspaceID != "ws_0123456789abcdef" || resp.Projects[0].Remote.Host != "alice@10.1.2.3" {
		t.Fatalf("unexpected remote project: %+v", resp.Projects[0])
	}
	if !resp.Projects[1].Manual || resp.Projects[1].Name != "My Custom" || resp.Projects[1].SessionTotal != 1 {
		t.Fatalf("unexpected manual project: %+v", resp.Projects[1])
	}

	// Verify /projects/sessions works for zero-session remote workspace.
	shadow, _ := webuiremoteworkspace.ShadowDir(aiHome, "ws_0123456789abcdef")
	sessReq := httptest.NewRequest(http.MethodGet, SessionsPath+"?projectPath="+filepath.Clean(shadow), nil)
	sessRec := httptest.NewRecorder()
	handler.ServeHTTP(sessRec, sessReq)
	if sessRec.Code != http.StatusOK {
		t.Fatalf("GET %s status = %d body=%s", SessionsPath, sessRec.Code, sessRec.Body.String())
	}

	// Verify ListAuthorizedProjectPaths matches.
	authorized, err := ListAuthorizedProjectPaths(ctx, hostHome, aiHome)
	if err != nil || len(authorized) != 2 {
		t.Fatalf("ListAuthorizedProjectPaths = (%+v, %v)", authorized, err)
	}

	// Verify NotifyWatchers pushes an updated snapshot to an active SSE subscriber.
	ctxWatch, cancelWatch := context.WithCancel(ctx)
	defer cancelWatch()
	handler.watchCoalesce = 5 * time.Millisecond
	handler.watchSourceFactory = func() (projectWatchSource, error) { return newIdleProjectWatchSource(), nil }
	watchReq := httptest.NewRequest(http.MethodGet, WatchPath, nil).WithContext(ctxWatch)
	watchRec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(watchRec, watchReq)
		close(done)
	}()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if hub := handler.watch(); hub.subscriberCount() > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !NotifyWatchers(ctx, aiHome) {
		t.Fatal("expected NotifyWatchers to broadcast to active hub")
	}
	cancelWatch()
	<-done
	handler.shutdownWatch()
}
