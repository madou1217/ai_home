package webuiworkspacefsapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/webuiremoteworkspace"
)

type staticAuthorizer struct{ allow bool }

func (a staticAuthorizer) Authorized(*http.Request) bool { return a.allow }

type fakeRemoteSession struct{}

func (fakeRemoteSession) Run(_ context.Context, cmd string, _ int) (sshremote.Result, error) {
	switch {
	case strings.Contains(cmd, "AIH_POSIX"):
		return sshremote.Result{Stdout: []byte("Linux\nAIH_POSIX\n")}, nil
	case strings.Contains(cmd, "--printf"):
		return sshremote.Result{Stdout: []byte("directory\t0\t1700\tsrc\nregular file\t5\t1701\t.env\nregular file\t10\t1702\tmain.go\n")}, nil
	case strings.Contains(cmd, "printf"):
		return sshremote.Result{Stdout: []byte("f 10 1702")}, nil
	case strings.Contains(cmd, "base64 <"):
		if strings.Contains(cmd, "pic.png") {
			pngBytes := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}
			return sshremote.Result{Stdout: []byte("8 1702\n" + base64.StdEncoding.EncodeToString(pngBytes))}, nil
		}
		return sshremote.Result{Stdout: []byte("12 1702\n" + base64.StdEncoding.EncodeToString([]byte("package main")))}, nil
	default:
		return sshremote.Result{Code: 3, Stderr: []byte("NOENT")}, nil
	}
}

func (fakeRemoteSession) Close() error { return nil }

func TestWorkspaceFSLocalAndRemote(t *testing.T) {
	ctx := context.Background()
	hostHome := t.TempDir()
	aiHome := filepath.Join(hostHome, ".ai_home")
	projectDir := filepath.Join(t.TempDir(), "local-proj")
	chatImgRoot := filepath.Join(t.TempDir(), "aih-web-chat-images")
	for _, dir := range []string{aiHome, filepath.Join(projectDir, "src"), chatImgRoot} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
	}
	if err := os.WriteFile(filepath.Join(projectDir, ".env"), []byte("SECRET=1"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projectDir, "src", "app.ts"), []byte("export const a = 1;"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(chatImgRoot, "paste.png"), []byte{0x89, 0x50, 0x4e, 0x47}, 0o644); err != nil {
		t.Fatal(err)
	}

	// Private projected artifact must be blocked.
	privDir := filepath.Join(aiHome, "run", "auth-projections", "claude", "acct_1")
	if err := os.MkdirAll(filepath.Join(privDir, "electron-user-data"), 0o755); err != nil {
		t.Fatal(err)
	}
	privFile := filepath.Join(privDir, "electron-user-data", "Cookies")
	if err := os.WriteFile(privFile, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}

	dbPath, _ := appstate.DatabasePath(aiHome)
	_ = appstate.WriteKV(ctx, dbPath, "ssh_connections", `[{"id":"c1","host":"10.0.0.1","user":"dev"}]`, 100)
	_ = appstate.WriteKV(ctx, dbPath, "ssh_workspaces", `[{"id":"ws_0123456789abcdef","connectionId":"c1","remoteRoot":"/srv/remote","label":"Remote"}]`, 100)
	remoteShadow, _ := webuiremoteworkspace.EnsureShadowDir(aiHome, "ws_0123456789abcdef")

	remoteSvc := webuiremoteworkspace.NewService(aiHome, hostHome, func(context.Context, webuiremoteworkspace.Connection, string) (webuiremoteworkspace.SessionRunner, error) {
		return fakeRemoteSession{}, nil
	})
	handler, err := NewHandler(Dependencies{
		Authorizer:       staticAuthorizer{allow: true},
		HostHomeDir:      hostHome,
		AiHomeDir:        aiHome,
		ChatImageRootDir: chatImgRoot,
		ProjectPaths:     func(context.Context) []string { return []string{projectDir, remoteShadow} },
		Remote:           remoteSvc,
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}

	get := func(path string, q url.Values) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path+"?"+q.Encode(), nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	// 1. Local tree respects showHidden=0 vs showHidden=1.
	t0 := get(TreePath, url.Values{"projectPath": {projectDir}})
	if t0.Code != http.StatusOK || strings.Contains(t0.Body.String(), ".env") || !strings.Contains(t0.Body.String(), `"src"`) {
		t.Fatalf("local tree showHidden=0 unexpected: %d %s", t0.Code, t0.Body.String())
	}
	t1 := get(TreePath, url.Values{"projectPath": {projectDir}, "showHidden": {"1"}})
	if t1.Code != http.StatusOK || !strings.Contains(t1.Body.String(), `".env"`) {
		t.Fatalf("local tree showHidden=1 unexpected: %d %s", t1.Code, t1.Body.String())
	}

	// 2. Local read, chat image media, and trust flow + private projection block.
	r1 := get(ReadPath, url.Values{"projectPath": {projectDir}, "path": {"src/app.ts"}})
	if r1.Code != http.StatusOK || !strings.Contains(r1.Body.String(), "export const a = 1;") {
		t.Fatalf("local read failed: %d %s", r1.Code, r1.Body.String())
	}
	m1 := get(MediaPath, url.Values{"path": {filepath.Join(chatImgRoot, "paste.png")}})
	if m1.Code != http.StatusOK || m1.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("chat image media failed: %d %s", m1.Code, m1.Header().Get("Content-Type"))
	}
	blocked := get(ReadPath, url.Values{"path": {privFile}})
	if blocked.Code != http.StatusForbidden {
		t.Fatalf("expected private electron-user-data file blocked 403, got %d %s", blocked.Code, blocked.Body.String())
	}

	// Trust outside root flow.
	outsideDir := filepath.Join(t.TempDir(), "docs")
	_ = os.MkdirAll(outsideDir, 0o755)
	outsideFile := filepath.Join(outsideDir, "readme.txt")
	_ = os.WriteFile(outsideFile, []byte("trusted content"), 0o644)
	if denied := get(ReadPath, url.Values{"path": {outsideFile}}); denied.Code != http.StatusForbidden {
		t.Fatalf("expected untrusted file 403, got %d", denied.Code)
	}
	var trustBuf bytes.Buffer
	_ = json.NewEncoder(&trustBuf).Encode(map[string]string{"path": outsideFile, "scope": "file_directory"})
	trustReq := httptest.NewRequest(http.MethodPost, TrustPath, &trustBuf)
	trustReq.Header.Set("Content-Type", "application/json")
	trustRec := httptest.NewRecorder()
	handler.ServeHTTP(trustRec, trustReq)
	if trustRec.Code != http.StatusOK {
		t.Fatalf("trust failed: %d %s", trustRec.Code, trustRec.Body.String())
	}
	if okRead := get(ReadPath, url.Values{"path": {outsideFile}}); okRead.Code != http.StatusOK || !strings.Contains(okRead.Body.String(), "trusted content") {
		t.Fatalf("expected trusted file 200, got %d %s", okRead.Code, okRead.Body.String())
	}

	// 3. Remote tree, access, read, media.
	rt := get(TreePath, url.Values{"projectPath": {remoteShadow}})
	if rt.Code != http.StatusOK || strings.Contains(rt.Body.String(), `".env"`) || !strings.Contains(rt.Body.String(), `"remote":true`) {
		t.Fatalf("remote tree unexpected: %d %s", rt.Code, rt.Body.String())
	}
	ra := get(AccessPath, url.Values{"projectPath": {remoteShadow}, "path": {"main.go:10"}})
	if ra.Code != http.StatusOK || !strings.Contains(ra.Body.String(), `"size":10`) {
		t.Fatalf("remote access unexpected: %d %s", ra.Code, ra.Body.String())
	}
	rr := get(ReadPath, url.Values{"projectPath": {remoteShadow}, "path": {"main.go"}})
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), "package main") {
		t.Fatalf("remote read unexpected: %d %s", rr.Code, rr.Body.String())
	}
	rm := get(MediaPath, url.Values{"projectPath": {remoteShadow}, "path": {"pic.png"}})
	if rm.Code != http.StatusOK || rm.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("remote media unexpected: %d %s", rm.Code, rm.Body.String())
	}
	if badMedia := get(MediaPath, url.Values{"projectPath": {remoteShadow}, "path": {"main.go"}}); badMedia.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("expected 415 for non-image media, got %d", badMedia.Code)
	}
}
