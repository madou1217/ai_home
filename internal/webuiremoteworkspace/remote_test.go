package webuiremoteworkspace

import (
	"context"
	"encoding/base64"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/sshremote"
)

type fakeRunner struct {
	calls  []string
	reply  func(cmd string, limit int) (sshremote.Result, error)
	closed bool
}

func (f *fakeRunner) Run(_ context.Context, cmd string, limit int) (sshremote.Result, error) {
	f.calls = append(f.calls, cmd)
	return f.reply(cmd, limit)
}

func (f *fakeRunner) Close() error {
	f.closed = true
	return nil
}

func TestShadowAndRelativePathGuards(t *testing.T) {
	aiHome := t.TempDir()
	wsID := "ws_0123456789abcdef"
	shadow, err := ShadowDir(aiHome, wsID)
	if err != nil {
		t.Fatalf("ShadowDir failed: %v", err)
	}
	if got := WorkspaceIDFromProjectPath(aiHome, shadow+"/"); got != wsID {
		t.Fatalf("WorkspaceIDFromProjectPath = %q, want %q", got, wsID)
	}
	if got := WorkspaceIDFromProjectPath(aiHome, filepath.Join(aiHome, "run", "remote-workspaces", "bad")); got != "" {
		t.Fatalf("expected invalid workspace id to return empty, got %q", got)
	}
	if rel, err := RelativePathFromShadow(shadow, filepath.Join(shadow, "src", "main.go")+":12:4"); err != nil || rel != "src/main.go" {
		t.Fatalf("RelativePathFromShadow = (%q, %v), want (src/main.go, nil)", rel, err)
	}
	if _, err := RelativePathFromShadow(shadow, "/etc/passwd"); err == nil {
		t.Fatal("expected absolute path outside shadow dir to be rejected")
	}
	if _, err := NormalizeRelativePath("../secret"); err == nil {
		t.Fatal("expected .. traversal to be rejected")
	}
	if got := JoinRemotePath(DialectPOSIX, "/srv/app/", "src/index.ts"); got != "/srv/app/src/index.ts" {
		t.Fatalf("JoinRemotePath posix = %q", got)
	}
	if got := JoinRemotePath(DialectPowerShell, `C:\work\app\`, "src/index.ts"); got != `C:\work\app\src\index.ts` {
		t.Fatalf("JoinRemotePath powershell = %q", got)
	}
}

func TestLoadWorkspacesAndConnectionsJumpChain(t *testing.T) {
	ctx := context.Background()
	aiHome := t.TempDir()
	dbPath, err := appstate.DatabasePath(aiHome)
	if err != nil {
		t.Fatalf("DatabasePath: %v", err)
	}
	connsJSON := `[
		{"id":"c-jump","label":"bastion","host":"10.0.0.1","user":"ops","port":2222,"authType":"agent"},
		{"id":"c-target","label":"dev","host":"10.0.0.2","user":"dev","egressConnectionId":"c-jump"},
		{"id":"c-tunnel","host":"10.0.0.3","user":"dev","reverseTunnel":{"enabled":true,"remotePort":9000}},
		{"id":"c-cycle","host":"10.0.0.4","user":"dev","egressConnectionId":"c-cycle"}
	]`
	workspacesJSON := `[
		{"id":"ws_0123456789abcdef","connectionId":"c-target","remoteRoot":"/srv/repo","label":"Remote Repo","createdAt":1700000000000},
		{"id":"bad_id","connectionId":"c-target","remoteRoot":"/tmp"}
	]`
	if err := appstate.WriteKV(ctx, dbPath, connectionsKey, connsJSON, 1000); err != nil {
		t.Fatalf("WriteKV connections: %v", err)
	}
	if err := appstate.WriteKV(ctx, dbPath, workspacesKey, workspacesJSON, 1000); err != nil {
		t.Fatalf("WriteKV workspaces: %v", err)
	}

	list, err := LoadWorkspaces(ctx, aiHome)
	if err != nil {
		t.Fatalf("LoadWorkspaces: %v", err)
	}
	if len(list) != 1 || list[0].Host != "dev@10.0.0.2" || list[0].HostLabel != "dev" || list[0].RemoteRoot != "/srv/repo" {
		t.Fatalf("unexpected workspaces: %+v", list)
	}
	conn, found, err := LoadConnection(ctx, aiHome, "c-target")
	if err != nil || !found || conn.Jump == nil || conn.Jump.ID != "c-jump" || conn.Jump.Port != 2222 {
		t.Fatalf("expected jump chain resolved, got (%+v, %v, %v)", conn, found, err)
	}
	if _, err := ToSSHConfig(conn, t.TempDir()); err != nil {
		t.Fatalf("ToSSHConfig valid jump: %v", err)
	}
	tunnelConn, found, _ := LoadConnection(ctx, aiHome, "c-tunnel")
	if !found {
		t.Fatal("c-tunnel not found")
	}
	if _, err := ToSSHConfig(tunnelConn, t.TempDir()); err == nil {
		t.Fatal("expected reverse tunnel to fail closed")
	}
	cycleConn, found, _ := LoadConnection(ctx, aiHome, "c-cycle")
	if !found {
		t.Fatal("c-cycle not found")
	}
	if _, err := ToSSHConfig(cycleConn, t.TempDir()); err == nil {
		t.Fatal("expected cycle egress chain to fail closed")
	}
}

func TestSessionPOSIXOperationsAndLimits(t *testing.T) {
	ctx := context.Background()
	aiHome := t.TempDir()
	dbPath, _ := appstate.DatabasePath(aiHome)
	_ = appstate.WriteKV(ctx, dbPath, connectionsKey, `[{"id":"c1","host":"1.2.3.4","user":"u"}]`, 100)
	_ = appstate.WriteKV(ctx, dbPath, workspacesKey, `[{"id":"ws_0123456789abcdef","connectionId":"c1","remoteRoot":"/srv/app","label":"app"}]`, 100)

	runner := &fakeRunner{
		reply: func(cmd string, _ int) (sshremote.Result, error) {
			switch {
			case strings.Contains(cmd, "AIH_POSIX"):
				return sshremote.Result{Stdout: []byte("Linux\nAIH_POSIX\n")}, nil
			case strings.Contains(cmd, "--printf"):
				return sshremote.Result{Stdout: []byte("directory\t0\t1700\tsrc\nregular file\t12\t1701\tREADME.md\n")}, nil
			case strings.Contains(cmd, "base64 <"):
				encoded := base64.StdEncoding.EncodeToString([]byte("hello remote"))
				return sshremote.Result{Stdout: []byte("12 1701\n" + encoded)}, nil
			case strings.Contains(cmd, "git "):
				return sshremote.Result{Stdout: []byte("main\n")}, nil
			default:
				return sshremote.Result{Code: 3, Stderr: []byte("NOENT")}, nil
			}
		},
	}

	svc := NewService(aiHome, t.TempDir(), func(context.Context, Connection, string) (SessionRunner, error) {
		return runner, nil
	})
	sess, err := svc.OpenSession(ctx, "ws_0123456789abcdef")
	if err != nil {
		t.Fatalf("OpenSession: %v", err)
	}
	defer func() { _ = sess.Close() }()

	entries, err := sess.ListDir(ctx, "")
	if err != nil || len(entries) != 2 || entries[0].Type != "d" || entries[1].Name != "README.md" {
		t.Fatalf("ListDir = (%+v, %v)", entries, err)
	}
	content, size, mtime, err := sess.ReadFile(ctx, "README.md", 1024)
	if err != nil || string(content) != "hello remote" || size != 12 || mtime != 1701 {
		t.Fatalf("ReadFile = (%q, %d, %d, %v)", string(content), size, mtime, err)
	}
	if _, _, _, err := sess.ReadFile(ctx, "README.md", 4); err == nil {
		t.Fatal("expected ReadFile over maxBytes to fail")
	} else {
		var remoteErr *RemoteError
		if !errors.As(err, &remoteErr) || remoteErr.Status != 413 {
			t.Fatalf("expected 413 too_large, got %v", err)
		}
	}
	gitRes, err := sess.RunGit(ctx, []string{"branch", "--show-current"}, 4096)
	if err != nil || string(gitRes.Stdout) != "main\n" {
		t.Fatalf("RunGit = (%+v, %v)", gitRes, err)
	}
	if _, err := sess.Stat(ctx, "missing.txt"); !IsNotFoundError(err) {
		t.Fatalf("expected not_found error, got %v", err)
	}
}
