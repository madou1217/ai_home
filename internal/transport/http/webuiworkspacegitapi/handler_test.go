package webuiworkspacegitapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/webuiremoteworkspace"
)

type staticAuthorizer struct{ allow bool }

func (a staticAuthorizer) Authorized(*http.Request) bool { return a.allow }

type fakeGitRunner struct{}

func (fakeGitRunner) Run(_ context.Context, cmd string, _ int) (sshremote.Result, error) {
	switch {
	case strings.Contains(cmd, "AIH_POSIX"):
		return sshremote.Result{Stdout: []byte("Linux\nAIH_POSIX\n")}, nil
	case strings.Contains(cmd, "status"):
		return sshremote.Result{Stdout: []byte(" M app.go\x00?? new.txt\x00")}, nil
	case strings.Contains(cmd, "branch"):
		return sshremote.Result{Stdout: []byte("feat/test\n")}, nil
	case strings.Contains(cmd, "rev-parse"):
		return sshremote.Result{Stdout: []byte("origin/feat/test\n")}, nil
	case strings.Contains(cmd, "rev-list"):
		return sshremote.Result{Stdout: []byte("2\t1\n")}, nil
	case strings.Contains(cmd, "diff"):
		return sshremote.Result{Stdout: []byte("@@ -1 +1 @@\n-old\n+new\n")}, nil
	default:
		return sshremote.Result{Code: 1}, nil
	}
}

func (fakeGitRunner) Close() error { return nil }

func TestWorkspaceGitLocalAndRemote(t *testing.T) {
	ctx := context.Background()
	hostHome := t.TempDir()
	aiHome := filepath.Join(hostHome, ".ai_home")
	_ = os.MkdirAll(aiHome, 0o755)
	repoDir := filepath.Join(t.TempDir(), "my-repo")
	_ = os.MkdirAll(repoDir, 0o755)

	runGitCmd := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-C", repoDir}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v failed: %v\n%s", args, err, string(out))
		}
	}
	runGitCmd("init", "-b", "main")
	runGitCmd("config", "user.email", "test@example.com")
	runGitCmd("config", "user.name", "Test")
	_ = os.WriteFile(filepath.Join(repoDir, "README.md"), []byte("v1\n"), 0o644)
	runGitCmd("add", "README.md")
	runGitCmd("commit", "-m", "init")
	_ = os.WriteFile(filepath.Join(repoDir, "README.md"), []byte("v2\n"), 0o644)

	dbPath, _ := appstate.DatabasePath(aiHome)
	_ = appstate.WriteKV(ctx, dbPath, "ssh_connections", `[{"id":"c1","host":"10.0.0.1","user":"dev"}]`, 100)
	_ = appstate.WriteKV(ctx, dbPath, "ssh_workspaces", `[{"id":"ws_0123456789abcdef","connectionId":"c1","remoteRoot":"/srv/repo","label":"Remote"}]`, 100)
	remoteShadow, _ := webuiremoteworkspace.EnsureShadowDir(aiHome, "ws_0123456789abcdef")

	remoteSvc := webuiremoteworkspace.NewService(aiHome, hostHome, func(context.Context, webuiremoteworkspace.Connection, string) (webuiremoteworkspace.SessionRunner, error) {
		return fakeGitRunner{}, nil
	})
	handler, err := NewHandler(Dependencies{
		Authorizer:   staticAuthorizer{allow: true},
		HostHomeDir:  hostHome,
		AiHomeDir:    aiHome,
		ProjectPaths: func(context.Context) []string { return []string{repoDir, remoteShadow} },
		Remote:       remoteSvc,
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}

	get := func(p string, q url.Values) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, p+"?"+q.Encode(), nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	// Reject unregistered local path.
	if unauth := get(SummaryPath, url.Values{"projectPath": {t.TempDir()}}); unauth.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for unregistered project, got %d", unauth.Code)
	}

	// Local summary + diff even outside hostHome.
	ls := get(SummaryPath, url.Values{"projectPath": {repoDir}})
	if ls.Code != http.StatusOK || !strings.Contains(ls.Body.String(), `"branch":"main"`) || !strings.Contains(ls.Body.String(), `"README.md"`) {
		t.Fatalf("local summary failed: %d %s", ls.Code, ls.Body.String())
	}
	ld := get(DiffPath, url.Values{"projectPath": {repoDir}, "path": {"README.md"}})
	if ld.Code != http.StatusOK || !strings.Contains(ld.Body.String(), "+v2") {
		t.Fatalf("local diff failed: %d %s", ld.Code, ld.Body.String())
	}

	// Remote summary + diff.
	rs := get(SummaryPath, url.Values{"projectPath": {remoteShadow}})
	if rs.Code != http.StatusOK || !strings.Contains(rs.Body.String(), `"remote":true`) || !strings.Contains(rs.Body.String(), `"ahead":2`) {
		t.Fatalf("remote summary failed: %d %s", rs.Code, rs.Body.String())
	}
	rd := get(DiffPath, url.Values{"projectPath": {remoteShadow}, "path": {"app.go"}, "staged": {"1"}})
	if rd.Code != http.StatusOK || !strings.Contains(rd.Body.String(), "+new") {
		t.Fatalf("remote diff failed: %d %s", rd.Code, rd.Body.String())
	}
	if bad := get(DiffPath, url.Values{"projectPath": {remoteShadow}, "path": {"../secret"}}); bad.Code != http.StatusBadRequest {
		t.Fatalf("expected invalid_file_path 400, got %d", bad.Code)
	}
}
