package webuisshapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/terminals"
)

type fakeTerminalLauncher struct {
	reqs   []TerminalLaunchRequest
	result TerminalLaunchResult
	err    *TerminalLaunchError
}

func (f *fakeTerminalLauncher) LaunchTerminal(_ context.Context, req TerminalLaunchRequest) (TerminalLaunchResult, *TerminalLaunchError) {
	f.reqs = append(f.reqs, req)
	if f.err != nil {
		return TerminalLaunchResult{}, f.err
	}
	res := f.result
	if res.TermID == "" {
		res.TermID = "term_1"
	}
	if res.SessionKey == "" {
		res.SessionKey = req.SessionKey
	}
	return res, nil
}

func doTerminalRequest(handler http.Handler, remoteAddr string, workspaceID string, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, WorkspacesPath+"/"+workspaceID+"/terminal", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = remoteAddr
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func makeFakeRepoRoot(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	binDir := filepath.Join(repo, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin: %v", err)
	}
	if err := os.WriteFile(filepath.Join(binDir, "ai-home.js"), []byte("// cli\n"), 0o644); err != nil {
		t.Fatalf("write ai-home.js: %v", err)
	}
	return repo
}

func TestWorkspaceTerminalAuthAndLookupErrors(t *testing.T) {
	wsID := "ws_0123456789abcdef"
	unauth, err := NewWorkspaceTerminalHandler(TerminalDependencies{
		Authorizer:  fakeAuthorizer{allowed: false},
		Connections: fakeStore{},
		Workspaces:  fakeWorkspaceStore{},
	})
	if err != nil {
		t.Fatalf("NewWorkspaceTerminalHandler: %v", err)
	}
	if rec := doTerminalRequest(unauth, "127.0.0.1:1234", wsID, `{}`); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauth status = %d, want 401", rec.Code)
	}

	handler, err := NewWorkspaceTerminalHandler(TerminalDependencies{
		Authorizer:  fakeAuthorizer{allowed: true},
		Connections: fakeStore{raw: `[]`, found: true},
		Workspaces:  fakeWorkspaceStore{raw: `[{"id":"` + wsID + `","connectionId":"conn_missing","label":"ws","remoteRoot":"/srv"}]`, found: true},
	})
	if err != nil {
		t.Fatalf("NewWorkspaceTerminalHandler: %v", err)
	}

	if rec := doTerminalRequest(handler, "127.0.0.1:1234", "ws_aaaaaaaaaaaaaaaa", `{}`); rec.Code != http.StatusNotFound {
		t.Fatalf("missing ws status = %d body=%s", rec.Code, rec.Body.String())
	}
	rec := doTerminalRequest(handler, "127.0.0.1:1234", wsID, `{}`)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "connection_not_found") {
		t.Fatalf("missing conn status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestWorkspaceTerminalSSHLaunchAndEgressValidation(t *testing.T) {
	wsID := "ws_0123456789abcdef"
	connsJSON := `[
		{"id":"conn_jump","host":"bastion.example.com","port":22,"user":"op","authType":"agent"},
		{"id":"conn_target","host":"10.0.0.8","port":2222,"user":"dev","authType":"password","password":"pw","egressConnectionId":"conn_jump"},
		{"id":"conn_bad_egress","host":"10.0.0.9","user":"dev","authType":"agent","egressConnectionId":"conn_gone"}
	]`
	wssJSON := `[
		{"id":"` + wsID + `","connectionId":"conn_target","label":"api","remoteRoot":"/srv/api"},
		{"id":"ws_bad_egress","connectionId":"conn_bad_egress","label":"broken","remoteRoot":"/srv/bad"}
	]`
	launcher := &fakeTerminalLauncher{result: TerminalLaunchResult{TermID: "t_99", Reused: true, Durable: false}}
	handler, err := NewWorkspaceTerminalHandler(TerminalDependencies{
		Authorizer:  fakeAuthorizer{allowed: true},
		Connections: fakeStore{raw: connsJSON, found: true},
		Workspaces:  fakeWorkspaceStore{raw: wssJSON, found: true},
		AIHomeDir:   t.TempDir(),
		HostHomeDir: t.TempDir(),
		Launcher:    launcher,
	})
	if err != nil {
		t.Fatalf("NewWorkspaceTerminalHandler: %v", err)
	}

	rec := doTerminalRequest(handler, "127.0.0.1:5000", wsID, `{"cols":120,"rows":36}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload["termId"] != "t_99" || payload["reused"] != true || payload["host"] != "dev@10.0.0.8" || payload["label"] != "api" || payload["remoteRoot"] != "/srv/api" {
		t.Fatalf("payload = %#v", payload)
	}
	if len(launcher.reqs) != 1 || launcher.reqs[0].Remote == nil {
		t.Fatalf("reqs = %#v", launcher.reqs)
	}
	cfg, ok := launcher.reqs[0].Remote.Config.(sshremote.Config)
	if !ok || cfg.Host != "10.0.0.8" || cfg.Jump == nil || cfg.Jump.Host != "bastion.example.com" {
		t.Fatalf("ssh config = %#v", launcher.reqs[0].Remote.Config)
	}
	if !strings.Contains(launcher.reqs[0].Remote.Command, "/srv/api") || !strings.Contains(launcher.reqs[0].Remote.Command, "tmux") {
		t.Fatalf("remote command = %q", launcher.reqs[0].Remote.Command)
	}

	// Fresh spawns a suffixed sessionKey.
	rec = doTerminalRequest(handler, "127.0.0.1:5000", wsID, `{"fresh":true}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("fresh status = %d", rec.Code)
	}
	if !strings.HasPrefix(launcher.reqs[1].SessionKey, "remote-ws:"+wsID+":") {
		t.Fatalf("fresh key = %q", launcher.reqs[1].SessionKey)
	}

	// Broken egress -> 409 egress_connection_invalid.
	rec = doTerminalRequest(handler, "127.0.0.1:5000", "ws_bad_egress", `{}`)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "egress_connection_invalid") {
		t.Fatalf("bad egress status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestWorkspaceTerminalAgentAndNativeModes(t *testing.T) {
	wsID := "ws_0123456789abcdef"
	aiHome := t.TempDir()
	repoRoot := makeFakeRepoRoot(t)
	desktop := true
	launcher := &fakeTerminalLauncher{result: TerminalLaunchResult{TermID: "t_ai", Durable: true}}
	var opened []terminals.OpenRequest

	handler, err := NewWorkspaceTerminalHandler(TerminalDependencies{
		Authorizer:   fakeAuthorizer{allowed: true},
		Connections:  fakeStore{raw: `[{"id":"conn_1","host":"10.0.0.1","user":"dev","authType":"agent"}]`, found: true},
		Workspaces:   fakeWorkspaceStore{raw: `[{"id":"` + wsID + `","connectionId":"conn_1","label":"web","remoteRoot":"/srv/web"}]`, found: true},
		AIHomeDir:    aiHome,
		RepoRoot:     repoRoot,
		NodeExecPath: "/usr/local/bin/node",
		DesktopHost:  &desktop,
		Launcher:     launcher,
		ClientOpener: func(req terminals.OpenRequest) terminals.OpenResult {
			opened = append(opened, req)
			return terminals.OpenResult{OK: true, Status: "launched", TerminalID: "system-default", Executable: "/bin/sh"}
		},
	})
	if err != nil {
		t.Fatalf("NewWorkspaceTerminalHandler: %v", err)
	}

	// Agent mode
	rec := doTerminalRequest(handler, "127.0.0.1:5000", wsID, `{"agent":"claude","cols":100,"rows":30}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("agent status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(launcher.reqs) != 1 {
		t.Fatalf("launcher reqs=%d", len(launcher.reqs))
	}
	req := launcher.reqs[0]
	expectedShadow := filepath.Join(aiHome, "run", "remote-workspaces", wsID)
	if req.SessionKey != "remote-ai:"+wsID+":claude" || req.Cwd != expectedShadow || req.File != "/usr/local/bin/node" {
		t.Fatalf("agent req = %#v", req)
	}
	if _, statErr := os.Stat(expectedShadow); statErr != nil {
		t.Fatalf("shadow dir not created: %v", statErr)
	}

	// Native rejected when clientPeer is non-loopback or forwarded.
	rec = doTerminalRequest(handler, "127.0.0.1:5000", wsID, `{"transport":"native","clientPeer":{"remoteAddr":"192.168.1.50"}}`)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "web_terminal_required") {
		t.Fatalf("remote peer native status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = doTerminalRequest(handler, "127.0.0.1:5000", wsID, `{"transport":"native","clientPeer":{"remoteAddr":"127.0.0.1","aihServerId":"srv_2"}}`)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "web_terminal_required") {
		t.Fatalf("forwarded native status=%d body=%s", rec.Code, rec.Body.String())
	}

	// Native allowed when loopback + no proxy headers + desktop host.
	rec = doTerminalRequest(handler, "127.0.0.1:5000", wsID, `{"transport":"native","terminalId":"system-default","clientPeer":{"remoteAddr":"::ffff:127.0.0.1"}}`)
	if rec.Code != http.StatusOK || len(opened) != 1 {
		t.Fatalf("local native status=%d opened=%d body=%s", rec.Code, len(opened), rec.Body.String())
	}
	if !strings.Contains(opened[0].Command, "__remote-ws") || !strings.Contains(opened[0].Command, wsID) {
		t.Fatalf("native command = %q", opened[0].Command)
	}
}
