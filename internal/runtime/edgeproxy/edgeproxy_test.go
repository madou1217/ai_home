package edgeproxy

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeCall struct {
	cmd  string
	args []string
}

type fakeRunner struct {
	calls   []fakeCall
	handler func(cmd string, args []string) ExecResult
}

func (r *fakeRunner) Run(_ context.Context, cmd string, args []string, _ time.Duration) ExecResult {
	r.calls = append(r.calls, fakeCall{cmd: cmd, args: append([]string(nil), args...)})
	if r.handler != nil {
		return r.handler(cmd, args)
	}
	return ExecResult{ExitCode: 0}
}

type testOSFS struct {
	osFS
	execs     map[string]bool
	nonWritab map[string]bool
}

func (f *testOSFS) IsExecutable(path string) bool {
	if f.execs != nil {
		if v, ok := f.execs[path]; ok {
			return v
		}
	}
	return false
}

func (f *testOSFS) IsWritable(path string) bool {
	if f.nonWritab != nil && f.nonWritab[path] {
		return false
	}
	return f.osFS.IsWritable(path)
}

func TestEdgeContextParsingAndStatus(t *testing.T) {
	dir := t.TempDir()
	frpConf := filepath.Join(dir, "frpc.toml")
	frpContent := `serverAddr = "1.2.3.4"
[[proxies]]
name = "ssh"
type = "tcp"
localIP = "127.0.0.1"
localPort = 22
remotePort = 2222

# aih-managed:aih-server
[[proxies]]
name = "aih-server"
type = "tcp"
localIP = "127.0.0.1"
localPort = 9527
remotePort = 29527
`
	if err := os.WriteFile(frpConf, []byte(frpContent), 0644); err != nil {
		t.Fatal(err)
	}
	nginxDir := filepath.Join(dir, "nginx")
	if err := os.MkdirAll(filepath.Join(nginxDir, "conf.d"), 0755); err != nil {
		t.Fatal(err)
	}
	caddyFile := filepath.Join(dir, "Caddyfile")
	if err := os.WriteFile(caddyFile, []byte("# existing\n"), 0644); err != nil {
		t.Fatal(err)
	}

	env := map[string]string{
		EdgeContextEnv: "frpcConfig=" + frpConf + ",nginxConfDir=" + nginxDir + ",caddyfile=" + caddyFile + ",frpcBin=/bin/frpc,nginxBin=/bin/nginx,caddyBin=/bin/caddy",
	}
	fsImpl := &testOSFS{
		execs: map[string]bool{"/bin/frpc": true, "/bin/nginx": true, "/bin/caddy": true},
	}
	runner := &fakeRunner{
		handler: func(cmd string, args []string) ExecResult {
			if cmd == "/bin/nginx" && len(args) > 0 && args[0] == "-v" {
				return ExecResult{ExitCode: 0, Stderr: "nginx version: nginx/1.25.4"}
			}
			return ExecResult{ExitCode: 0}
		},
	}
	svc := NewServiceWithDeps(fsImpl, runner, env, func() time.Time {
		return time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	})

	status := svc.Status(context.Background(), 9530)
	if !status.OK || status.AIHPort != 9530 {
		t.Fatalf("unexpected status header: %+v", status)
	}
	if !status.Providers.Frp.Installed || !status.Providers.Frp.Writable || len(status.Providers.Frp.Proxies) != 2 {
		t.Fatalf("unexpected frp status: %+v", status.Providers.Frp)
	}
	if status.Providers.Frp.Proxies[0].Managed || !status.Providers.Frp.Proxies[1].Managed {
		t.Fatalf("unexpected managed flags: %+v", status.Providers.Frp.Proxies)
	}
	if status.Providers.Nginx.Version != "1.25.4" || status.Providers.Nginx.ConfigDir != nginxDir {
		t.Fatalf("unexpected nginx status: %+v", status.Providers.Nginx)
	}
	if !status.Providers.Caddy.Installed || status.Providers.Caddy.ConfigPath != caddyFile {
		t.Fatalf("unexpected caddy status: %+v", status.Providers.Caddy)
	}
}

func TestApplyFrpIdempotentAndRejectCleanup(t *testing.T) {
	dir := t.TempDir()
	frpConf := filepath.Join(dir, "frpc.toml")
	orig := "serverAddr = \"1.2.3.4\"\n\n[[proxies]]\nname = \"user-ssh\"\ntype = \"tcp\"\nlocalIP = \"127.0.0.1\"\nlocalPort = 22\nremotePort = 2222\n"
	if err := os.WriteFile(frpConf, []byte(orig), 0644); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{
		EdgeContextEnv: "frpcConfig=" + frpConf + ",frpcBin=/bin/frpc",
		"HOME":         dir,
	}
	fsImpl := &testOSFS{execs: map[string]bool{"/bin/frpc": true}}

	failRunner := &fakeRunner{
		handler: func(cmd string, args []string) ExecResult {
			return ExecResult{ExitCode: 1, Stderr: "bad config syntax"}
		},
	}
	svcFail := NewServiceWithDeps(fsImpl, failRunner, env, time.Now)
	_, edgeErr := svcFail.Apply(context.Background(), "frp", PlanOptions{RemotePort: 29527, UDP: true, AIHPort: 9527, Reload: true})
	if edgeErr == nil || edgeErr.Code != "edge_config_rejected" {
		t.Fatalf("expected edge_config_rejected, got %+v", edgeErr)
	}
	gotAfterFail, _ := os.ReadFile(frpConf)
	if string(gotAfterFail) != orig {
		t.Fatalf("original file should remain untouched on staged verify failure")
	}
	if _, err := os.Stat(frpConf + ".aih-staged"); !os.IsNotExist(err) {
		t.Fatalf("staged file should be removed")
	}

	okRunner := &fakeRunner{}
	svcOK := NewServiceWithDeps(fsImpl, okRunner, env, time.Now)
	for i := 0; i < 2; i++ {
		res, err := svcOK.Apply(context.Background(), "frp", PlanOptions{RemotePort: 29527 + i, UDP: true, AIHPort: 9527, Reload: true})
		if err != nil || !res.OK {
			t.Fatalf("apply %d failed: res=%+v err=%+v", i, res, err)
		}
	}
	finalBytes, _ := os.ReadFile(frpConf)
	finalStr := string(finalBytes)
	if !strings.Contains(finalStr, "name = \"user-ssh\"") {
		t.Fatalf("user proxy lost: %s", finalStr)
	}
	if strings.Count(finalStr, "[[proxies]]") != 3 {
		t.Fatalf("expected exactly 3 [[proxies]] blocks (user + tcp + udp), got:\n%s", finalStr)
	}
	if !strings.Contains(finalStr, "remotePort = 29528") {
		t.Fatalf("expected updated remotePort 29528, got:\n%s", finalStr)
	}
}

func TestApplyNginxIncludeAndRollbackOnValidationError(t *testing.T) {
	dir := t.TempDir()
	nginxDir := filepath.Join(dir, "nginx")
	if err := os.MkdirAll(filepath.Join(nginxDir, "conf.d"), 0755); err != nil {
		t.Fatal(err)
	}
	mainConf := filepath.Join(nginxDir, "nginx.conf")
	origMain := "worker_processes 1;\nhttp {\n    include conf.d/*.conf;\n}\n"
	if err := os.WriteFile(mainConf, []byte(origMain), 0644); err != nil {
		t.Fatal(err)
	}

	env := map[string]string{
		EdgeContextEnv: "nginxConfDir=" + nginxDir + ",nginxBin=/bin/nginx",
	}
	fsImpl := &testOSFS{execs: map[string]bool{"/bin/nginx": true}}

	// Invalid mode fails fast
	svcBadMode := NewServiceWithDeps(fsImpl, &fakeRunner{}, env, time.Now)
	if _, err := svcBadMode.Plan("nginx", PlanOptions{Domain: "example.com", Mode: "bogus"}); err == nil || err.Code != "edge_invalid_mode" {
		t.Fatalf("expected edge_invalid_mode, got %+v", err)
	}

	// nginx -t failure rolls back newly written files AND restored nginx.conf
	rejectRunner := &fakeRunner{
		handler: func(cmd string, args []string) ExecResult {
			if len(args) > 0 && args[0] == "-t" {
				return ExecResult{ExitCode: 1, Stderr: "nginx: configuration file test failed"}
			}
			return ExecResult{ExitCode: 0}
		},
	}
	svcReject := NewServiceWithDeps(fsImpl, rejectRunner, env, time.Now)
	_, edgeErr := svcReject.Apply(context.Background(), "nginx", PlanOptions{
		Domain:  "ai.example.com",
		Mode:    "split",
		AIHPort: 9527,
		Reload:  true,
	})
	if edgeErr == nil || edgeErr.Code != "edge_config_rejected" {
		t.Fatalf("expected edge_config_rejected, got %+v", edgeErr)
	}
	restoredMain, _ := os.ReadFile(mainConf)
	if string(restoredMain) != origMain {
		t.Fatalf("nginx.conf not rolled back: %s", string(restoredMain))
	}
	if _, err := os.Stat(filepath.Join(nginxDir, "aih-edge-stream.conf")); !os.IsNotExist(err) {
		t.Fatalf("stream conf should be rolled back")
	}

	// Success case
	okRunner := &fakeRunner{}
	svcOK := NewServiceWithDeps(fsImpl, okRunner, env, time.Now)
	res, err := svcOK.Apply(context.Background(), "nginx", PlanOptions{
		Domain:  "ai.example.com",
		Mode:    "split",
		AIHPort: 9527,
		Reload:  true,
	})
	if err != nil || !res.OK || !res.Reloaded || res.ReloadedVia != "nginx-s" {
		t.Fatalf("expected reload success, got res=%+v err=%+v", res, err)
	}
	updatedMain, _ := os.ReadFile(mainConf)
	if !strings.Contains(string(updatedMain), "include "+filepath.Join(nginxDir, "aih-edge-stream.conf")) {
		t.Fatalf("expected stream include in nginx.conf: %s", string(updatedMain))
	}
}

func TestApplyCaddyManagedBlockAndRollback(t *testing.T) {
	dir := t.TempDir()
	caddyFile := filepath.Join(dir, "Caddyfile")
	orig := "other.example.com {\n\trespond \"ok\"\n}\n"
	if err := os.WriteFile(caddyFile, []byte(orig), 0644); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{
		EdgeContextEnv: "caddyfile=" + caddyFile + ",caddyBin=/bin/caddy",
	}
	fsImpl := &testOSFS{execs: map[string]bool{"/bin/caddy": true}}

	failRunner := &fakeRunner{
		handler: func(cmd string, args []string) ExecResult {
			return ExecResult{ExitCode: 1, Stderr: "caddy validate error"}
		},
	}
	svcFail := NewServiceWithDeps(fsImpl, failRunner, env, time.Now)
	if _, err := svcFail.Apply(context.Background(), "caddy", PlanOptions{Domain: "a.example.com", AIHPort: 9527, Reload: true}); err == nil || err.Code != "edge_config_rejected" {
		t.Fatalf("expected edge_config_rejected, got %+v", err)
	}
	afterFail, _ := os.ReadFile(caddyFile)
	if string(afterFail) != orig {
		t.Fatalf("caddyfile should be restored on validate error, got:\n%s", string(afterFail))
	}

	okRunner := &fakeRunner{}
	svcOK := NewServiceWithDeps(fsImpl, okRunner, env, time.Now)
	for i := 0; i < 2; i++ {
		res, err := svcOK.Apply(context.Background(), "caddy", PlanOptions{Domain: "a.example.com", AIHPort: 9527 + i, Reload: true})
		if err != nil || !res.OK || !res.Reloaded {
			t.Fatalf("caddy apply %d failed: res=%+v err=%+v", i, res, err)
		}
	}
	finalBytes, _ := os.ReadFile(caddyFile)
	finalStr := string(finalBytes)
	if strings.Count(finalStr, "# >>> aih-edge:a.example.com >>>") != 1 {
		t.Fatalf("managed block duplicated:\n%s", finalStr)
	}
	if !strings.Contains(finalStr, "127.0.0.1:9528") || !strings.Contains(finalStr, "other.example.com") {
		t.Fatalf("unexpected caddyfile contents:\n%s", finalStr)
	}
}
