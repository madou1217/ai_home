package tools

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/configedit"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

type stubExec struct {
	mu    sync.Mutex
	calls []string
	fn    func(ctx context.Context, command string, args []string, opts environment.ExecOptions) environment.RunResult
}

func (s *stubExec) Run(ctx context.Context, command string, args []string, opts environment.ExecOptions) environment.RunResult {
	s.mu.Lock()
	s.calls = append(s.calls, command+" "+strings.Join(args, " "))
	s.mu.Unlock()
	if s.fn != nil {
		return s.fn(ctx, command, args, opts)
	}
	return environment.RunResult{OK: true}
}

type stubHTTPDoer struct {
	fn func(req *http.Request) (*http.Response, error)
}

func (s stubHTTPDoer) Do(req *http.Request) (*http.Response, error) {
	return s.fn(req)
}

func httpResp(status int, body []byte) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(bytes.NewReader(body)),
	}
}

func TestDiscoveryFrpcAmbiguity(t *testing.T) {
	tmp := t.TempDir()
	cfg1 := filepath.Join(tmp, "a.toml")
	cfg2 := filepath.Join(tmp, "b.toml")
	if err := os.WriteFile(cfg1, []byte("serverPort = 7000\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfg2, []byte("serverPort = 7001\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	opts := Options{
		Platform:    "linux",
		HostHomeDir: tmp,
		Exec:        &stubExec{},
		LookupEnv:   func(string) string { return "" },
		ProcessEntriesOverride: []ProcessEntry{
			{PID: 101, ExecutablePath: "/usr/bin/frpc", CommandLine: "/usr/bin/frpc -c " + cfg1},
		},
		StartupEntriesOverride: []StartupEntry{},
	}
	rt := DiscoverNetworkTools(context.Background(), opts)["frpc"]
	if !rt.Running || rt.ConfigState != "single" || rt.ConfigPath != cfg1 || rt.ConfigAmbiguous {
		t.Fatalf("unexpected runtime: %+v", rt)
	}

	opts.ProcessEntriesOverride = append(opts.ProcessEntriesOverride, ProcessEntry{
		PID: 102, ExecutablePath: "/usr/bin/frpc", CommandLine: "/usr/bin/frpc --config=" + cfg2,
	})
	rtMulti := DiscoverNetworkTools(context.Background(), opts)["frpc"]
	if rtMulti.ConfigState != "multiple" || !rtMulti.ConfigAmbiguous || rtMulti.ConfigCount != 2 {
		t.Fatalf("expected multiple ambiguous config, got %+v", rtMulti)
	}

	optsUnresolved := Options{
		Platform:               "linux",
		HostHomeDir:            tmp,
		Exec:                   &stubExec{},
		LookupEnv:              func(k string) string { if k == "FRPC_CONFIG" { return filepath.Join(tmp, "missing.toml") }; return "" },
		ProcessEntriesOverride: []ProcessEntry{},
		StartupEntriesOverride: []StartupEntry{},
	}
	rtUnres := DiscoverNetworkTools(context.Background(), optsUnresolved)["frpc"]
	if rtUnres.ConfigState != "unresolved" || !rtUnres.ConfigAmbiguous {
		t.Fatalf("expected unresolved config, got %+v", rtUnres)
	}
}

func TestListToolsAndConfigEdit(t *testing.T) {
	tmp := t.TempDir()
	herdrCfg := filepath.Join(tmp, "herdr.toml")
	frpcCfg := filepath.Join(tmp, "frpc.toml")
	if err := os.WriteFile(frpcCfg, []byte("serverPort = 7000\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	fakeExe := filepath.Join(tmp, "frpc")
	if err := os.WriteFile(fakeExe, []byte("#!/bin/sh\necho 0.61.1\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	verifyCalls := 0
	execStub := &stubExec{
		fn: func(_ context.Context, cmd string, args []string, _ environment.ExecOptions) environment.RunResult {
			if cmd == fakeExe && len(args) > 0 && args[0] == "--version" {
				return environment.RunResult{OK: true, Stdout: "0.61.1\n"}
			}
			if cmd == fakeExe && len(args) >= 3 && args[0] == "verify" && args[1] == "-c" {
				verifyCalls++
				data, _ := os.ReadFile(args[2])
				if strings.Contains(string(data), "INVALID") {
					return environment.RunResult{OK: false, Stderr: "bad syntax"}
				}
				return environment.RunResult{OK: true}
			}
			return environment.RunResult{OK: false}
		},
	}

	opts := Options{
		Platform:    "linux",
		Arch:        "amd64",
		HostHomeDir: tmp,
		AIHomeDir:   filepath.Join(tmp, "aih"),
		Exec:        execStub,
		LookupEnv: func(k string) string {
			switch k {
			case "HERDR_CONFIG_PATH":
				return herdrCfg
			case "FRPC_CONFIG":
				return frpcCfg
			}
			return ""
		},
		ProcessEntriesOverride: []ProcessEntry{},
		StartupEntriesOverride: []StartupEntry{},
		LookPathOverride: func(name string) (string, error) {
			if name == "frpc" {
				return fakeExe, nil
			}
			return "", errors.New("not found")
		},
	}

	listed := ListManagedTools(context.Background(), opts, nil)
	if !listed.OK || listed.Platform != "linux" || listed.Total != 5 {
		t.Fatalf("unexpected linux tools list: %+v", listed)
	}
	for _, tool := range listed.Tools {
		if tool.ID == "psmux" {
			t.Fatalf("psmux must not appear on linux")
		}
		if tool.ID == "frpc" && (!tool.Installed || tool.Version != "0.61.1" || tool.ManagedBy != "external") {
			t.Fatalf("unexpected frpc tool view: %+v", tool)
		}
	}

	// Read and validate TOML error on herdr
	readHerdr, err := ReadToolConfig(context.Background(), "herdr", opts)
	if err != nil {
		t.Fatalf("read herdr config failed: %v", err)
	}
	if readHerdr.Exists || readHerdr.Revision != "missing" {
		t.Fatalf("expected missing creatable herdr config, got %+v", readHerdr)
	}
	if _, err := SaveToolConfig(context.Background(), "herdr", "broken = [", readHerdr.Revision, readHerdr.TargetRevision, opts); err == nil {
		t.Fatalf("expected TOML validation failure")
	} else if configedit.HTTPStatus(err) != 422 {
		t.Fatalf("expected 422 validation error, got %d (%v)", configedit.HTTPStatus(err), err)
	}
	if _, err := SaveToolConfig(context.Background(), "herdr", "port = 9000\n", readHerdr.Revision, "wrong-target-rev", opts); err == nil {
		t.Fatalf("expected target revision mismatch")
	} else if configedit.HTTPStatus(err) != 409 {
		t.Fatalf("expected 409 conflict, got %d (%v)", configedit.HTTPStatus(err), err)
	}
	saved, err := SaveToolConfig(context.Background(), "herdr", "port = 9000\n", readHerdr.Revision, readHerdr.TargetRevision, opts)
	if err != nil || !saved.OK {
		t.Fatalf("expected herdr save success, got %+v err=%v", saved, err)
	}

	// Validate frpc binary verification hook
	readFrpc, err := ReadToolConfig(context.Background(), "frpc", opts)
	if err != nil {
		t.Fatalf("read frpc failed: %v", err)
	}
	if _, err := SaveToolConfig(context.Background(), "frpc", "INVALID", readFrpc.Revision, readFrpc.TargetRevision, opts); err == nil || configedit.HTTPStatus(err) != 422 {
		t.Fatalf("expected 422 frpc verify error, got %v", err)
	}
	if _, err := SaveToolConfig(context.Background(), "frpc", "serverPort = 7002\n", readFrpc.Revision, readFrpc.TargetRevision, opts); err != nil {
		t.Fatalf("expected valid frpc save, got %v", err)
	}
	if verifyCalls != 2 {
		t.Fatalf("expected 2 frpc verify calls, got %d", verifyCalls)
	}
}

func buildTestTarGz(name string, content []byte) ([]byte, error) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	hdr := &tar.Header{Name: name, Mode: 0o755, Size: int64(len(content)), Typeflag: tar.TypeReg}
	if err := tw.WriteHeader(hdr); err != nil {
		return nil, err
	}
	if _, err := tw.Write(content); err != nil {
		return nil, err
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func TestFrpcAndHerdrOfficialReleases(t *testing.T) {
	tmp := t.TempDir()
	frpcTar, err := buildTestTarGz("frp_0.62.0_linux_amd64/frpc", []byte("FAKE_FRPC_BIN"))
	if err != nil {
		t.Fatal(err)
	}
	frpcSum := sha256.Sum256(frpcTar)
	frpcDigest := hex.EncodeToString(frpcSum[:])
	checksumsText := frpcDigest + "  frp_0.62.0_linux_amd64.tar.gz\n"

	herdrBin := []byte("FAKE_HERDR_BIN")
	herdrSum := sha256.Sum256(herdrBin)
	herdrDigest := hex.EncodeToString(herdrSum[:])

	metaJSON, _ := json.Marshal(map[string]any{
		"tag_name": "v0.62.0",
		"assets": []map[string]string{
			{"name": "frp_0.62.0_linux_amd64.tar.gz", "browser_download_url": "https://github.com/fatedier/frp/releases/download/v0.62.0/frp_0.62.0_linux_amd64.tar.gz"},
			{"name": "frp_sha256_checksums.txt", "browser_download_url": "https://github.com/fatedier/frp/releases/download/v0.62.0/frp_sha256_checksums.txt"},
		},
	})
	herdrManifestJSON, _ := json.Marshal(map[string]any{
		"version": "1.2.3",
		"assets":  map[string]string{"linux-x86_64": "https://github.com/herdrdev/herdr/releases/download/v1.2.3/herdr-linux-x86_64"},
		"sha256":  map[string]string{"linux-x86_64": herdrDigest},
	})

	client := stubHTTPDoer{fn: func(req *http.Request) (*http.Response, error) {
		switch req.URL.String() {
		case frpcReleaseAPIURL:
			return httpResp(200, metaJSON), nil
		case "https://github.com/fatedier/frp/releases/download/v0.62.0/frp_sha256_checksums.txt":
			return httpResp(200, []byte(checksumsText)), nil
		case "https://github.com/fatedier/frp/releases/download/v0.62.0/frp_0.62.0_linux_amd64.tar.gz":
			return httpResp(200, frpcTar), nil
		case herdrManifestURL:
			return httpResp(200, herdrManifestJSON), nil
		case "https://github.com/herdrdev/herdr/releases/download/v1.2.3/herdr-linux-x86_64":
			return httpResp(200, herdrBin), nil
		default:
			return httpResp(404, nil), nil
		}
	}}

	execStub := &stubExec{
		fn: func(_ context.Context, cmd string, args []string, _ environment.ExecOptions) environment.RunResult {
			if strings.Contains(cmd, "frpc") && len(args) > 0 && args[0] == "--version" {
				return environment.RunResult{OK: true, Stdout: "0.62.0\n"}
			}
			if strings.Contains(cmd, "herdr") && len(args) > 0 && args[0] == "--version" {
				return environment.RunResult{OK: true, Stdout: "herdr 1.2.3\n"}
			}
			return environment.RunResult{OK: false}
		},
	}

	opts := Options{
		Platform:    "linux",
		Arch:        "amd64",
		HostHomeDir: tmp,
		HTTPClient:  client,
		Exec:        execStub,
	}
	if err := InstallFrpcRelease(context.Background(), "", opts); err != nil {
		t.Fatalf("InstallFrpcRelease failed: %v", err)
	}
	installedFrpc, err := os.ReadFile(ResolveManagedFrpcPath(opts))
	if err != nil || string(installedFrpc) != "FAKE_FRPC_BIN" {
		t.Fatalf("unexpected frpc payload: %q err=%v", installedFrpc, err)
	}

	// Test checksum mismatch fails cleanly
	badClient := stubHTTPDoer{fn: func(req *http.Request) (*http.Response, error) {
		if strings.HasSuffix(req.URL.String(), ".tar.gz") {
			return httpResp(200, []byte("corrupted")), nil
		}
		return client.Do(req)
	}}
	badOpts := opts
	badOpts.HTTPClient = badClient
	if err := InstallFrpcRelease(context.Background(), "", badOpts); err == nil || !strings.Contains(err.Error(), "SHA256") {
		t.Fatalf("expected SHA256 mismatch error, got %v", err)
	}

	if err := InstallHerdrRelease(context.Background(), "", opts); err != nil {
		t.Fatalf("InstallHerdrRelease failed: %v", err)
	}
	installedHerdr, err := os.ReadFile(ResolveHerdrPath(opts))
	if err != nil || string(installedHerdr) != "FAKE_HERDR_BIN" {
		t.Fatalf("unexpected herdr payload: %q err=%v", installedHerdr, err)
	}
}

func TestLifecyclePlanAndJobManager(t *testing.T) {
	tmp := t.TempDir()
	opts := Options{
		Platform:               "darwin",
		Arch:                   "arm64",
		HostHomeDir:            tmp,
		Exec:                   &stubExec{},
		LookupEnv:              func(string) string { return "" },
		ProcessEntriesOverride: []ProcessEntry{},
		StartupEntriesOverride: []StartupEntry{},
		LookPathOverride: func(name string) (string, error) {
			if name == "brew" {
				return "/opt/homebrew/bin/brew", nil
			}
			return "", errors.New("not found")
		},
	}

	plan := PlanManagedToolAction(context.Background(), "frpc", "install", opts)
	if !plan.OK || len(plan.Plans) != 2 || plan.Plans[0].ID != "frpc_install_homebrew" || plan.Plans[1].ID != "frpc_install_official_release" {
		t.Fatalf("unexpected darwin frpc install plans: %+v", plan)
	}

	jm := NewJobManager(opts)
	events, cancelSub := jm.Subscribe()
	defer cancelSub()

	unconfirmed := jm.Start(context.Background(), "frpc", "install", false, nil)
	if unconfirmed.OK || unconfirmed.Error != "confirmation_required" {
		t.Fatalf("expected confirmation_required, got %+v", unconfirmed)
	}

	installedAfter := false
	jm.RunPlanOverride = func(_ context.Context, p environment.Plan, _ Options) environment.RunResult {
		if p.ID == "frpc_install_homebrew" {
			return environment.RunResult{OK: false, Message: "brew unavailable"}
		}
		installedAfter = true
		return environment.RunResult{OK: true}
	}
	jm.ProbeOverride = func(_ context.Context, id string, _ Options) *ToolView {
		return &ToolView{ID: id, Installed: installedAfter, ExecutablePath: "/usr/local/bin/frpc", Version: "0.62.0"}
	}

	started := jm.Start(context.Background(), "frpc", "install", true, nil)
	if !started.OK || !started.Accepted || started.Job == nil {
		t.Fatalf("expected accepted job, got %+v", started)
	}

	// Wait for completion event
	deadline := time.After(3 * time.Second)
	var finalJob ToolJobView
	for {
		select {
		case evt := <-events:
			if isToolJobTerminal(evt.Job.Status) {
				finalJob = evt.Job
				goto done
			}
		case <-deadline:
			t.Fatal("timed out waiting for job completion")
		}
	}
done:
	if finalJob.Status != "succeeded" || len(finalJob.Attempts) != 2 || finalJob.Attempts[0].OK || !finalJob.Attempts[1].OK {
		t.Fatalf("expected fallback succeed job, got %+v", finalJob)
	}
	if resCancel := jm.Cancel(finalJob.ID); resCancel.OK || resCancel.Error != "job_not_cancellable" {
		t.Fatalf("expected job_not_cancellable, got %+v", resCancel)
	}
}

func TestServiceManagerHomebrewAndAihSupervisor(t *testing.T) {
	tmp := t.TempDir()
	aiHome := filepath.Join(tmp, "aih")
	fakeFrpc := filepath.Join(tmp, ".local", "bin", "frpc")
	if err := os.MkdirAll(filepath.Dir(fakeFrpc), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fakeFrpc, []byte("bin"), 0o755); err != nil {
		t.Fatal(err)
	}

	var procAlive bool
	var exitCh chan struct{}

	opts := Options{
		Platform:               "linux",
		Arch:                   "amd64",
		HostHomeDir:            tmp,
		AIHomeDir:              aiHome,
		Exec:                   &stubExec{fn: func(_ context.Context, _ string, args []string, _ environment.ExecOptions) environment.RunResult { return environment.RunResult{OK: true, Stdout: "0.62.0"} }},
		LookupEnv:              func(string) string { return "" },
		ProcessEntriesOverride: []ProcessEntry{},
		StartupEntriesOverride: []StartupEntry{},
		LookPathOverride:       func(string) (string, error) { return "", errors.New("not found") },
	}
	sm := NewServiceManager(opts)
	defer sm.Dispose()

	sm.Hooks = SupervisorHooks{
		Spawn: func(spec LaunchSpec, logFile string) (SpawnedProcess, error) {
			procAlive = true
			exitCh = make(chan struct{})
			_ = os.MkdirAll(filepath.Dir(logFile), 0o755)
			_ = os.WriteFile(logFile, []byte("\x1b[32minfo\x1b[0m frpc started\n"), 0o600)
			return SpawnedProcess{
				PID: 4321,
				Wait: func() (*int, string) {
					<-exitCh
					z := 0
					return &z, ""
				},
			}, nil
		},
		IsAlive: func(pid int) bool { return procAlive && pid == 4321 },
		IsOwned: func(pid int, _ string) bool { return procAlive && pid == 4321 },
		Kill: func(pid int, _ string) bool {
			if procAlive && pid == 4321 {
				procAlive = false
				close(exitCh)
				return true
			}
			return false
		},
	}

	// Create config
	created := sm.CreateToolServiceConfig(context.Background(), "frpc")
	if !created.OK || created.ConfigName != "frpc.toml" {
		t.Fatalf("expected create config success, got %+v", created)
	}
	if dup := sm.CreateToolServiceConfig(context.Background(), "frpc"); dup.OK || dup.Error != "service_config_exists" {
		t.Fatalf("expected service_config_exists, got %+v", dup)
	}

	// Conflict check
	conflictOpts := opts
	conflictOpts.ProcessEntriesOverride = []ProcessEntry{
		{PID: 9999, ExecutablePath: fakeFrpc, CommandLine: fakeFrpc + " -c " + filepath.Join(tmp, ".config", "frp", "frpc.toml")},
	}
	smConflict := NewServiceManager(conflictOpts)
	defer smConflict.Dispose()
	if res := smConflict.ControlToolService(context.Background(), "frpc", "start"); res.OK || res.Error != "service_conflict_external_instance" {
		t.Fatalf("expected conflict error, got %+v", res)
	}

	// Start, read logs, update settings, stop
	started := sm.ControlToolService(context.Background(), "frpc", "start")
	if !started.OK || started.PID != 4321 || started.Service == nil || started.Service.State != "running" {
		t.Fatalf("expected running frpc service, got %+v", started)
	}
	logs := sm.ReadToolServiceLogs(context.Background(), "frpc", 10)
	if !logs.OK || len(logs.Lines) != 1 || logs.Lines[0] != "info frpc started" {
		t.Fatalf("expected stripped log line, got %+v", logs)
	}
	falseVal := false
	upd := sm.UpdateToolServiceSettings(context.Background(), "frpc", &falseVal, nil)
	if !upd.OK || upd.Service.AutoStart {
		t.Fatalf("expected autoStart false, got %+v", upd)
	}
	stopped := sm.ControlToolService(context.Background(), "frpc", "stop")
	if !stopped.OK || stopped.Service.State != "stopped" {
		t.Fatalf("expected stopped service, got %+v", stopped)
	}

	// Homebrew backend status & control
	brewExe := "/opt/homebrew/bin/brew"
	brewCalls := 0
	brewOpts := Options{
		Platform:               "darwin",
		Arch:                   "arm64",
		HostHomeDir:            tmp,
		AIHomeDir:              aiHome,
		ProcessEntriesOverride: []ProcessEntry{},
		StartupEntriesOverride: []StartupEntry{},
		LookPathOverride: func(name string) (string, error) {
			if name == "frpc" {
				return "/opt/homebrew/bin/frpc", nil
			}
			return "", errors.New("miss")
		},
		FileExistsOverride: func(p string) bool { return p == brewExe },
		Exec: &stubExec{fn: func(_ context.Context, cmd string, args []string, _ environment.ExecOptions) environment.RunResult {
			if cmd == brewExe && len(args) >= 3 && args[0] == "services" && args[1] == "info" {
				brewCalls++
				return environment.RunResult{OK: true, Stdout: `[{"running":true,"pid":888,"registered":true,"loaded":true,"log_path":""}]`}
			}
			if cmd == brewExe && len(args) >= 2 && args[0] == "services" {
				return environment.RunResult{OK: true, Stdout: "Successfully stopped `frpc`"}
			}
			return environment.RunResult{OK: true, Stdout: "0.62.0"}
		}},
	}
	smBrew := NewServiceManager(brewOpts)
	defer smBrew.Dispose()
	desc := smBrew.DescribeToolService(context.Background(), "frpc")
	if !desc.OK || desc.Service.Backend != "homebrew" || !desc.Service.Controllable || desc.Service.State != "running" {
		t.Fatalf("expected homebrew service status, got %+v", desc)
	}
	// Cached read should not re-run brew services info
	_ = smBrew.DescribeToolService(context.Background(), "frpc")
	if brewCalls != 1 {
		t.Fatalf("expected cached brew info (1 call), got %d", brewCalls)
	}
	if ro := smBrew.UpdateToolServiceSettings(context.Background(), "frpc", &falseVal, nil); ro.OK || ro.Error != "service_settings_readonly" {
		t.Fatalf("expected readonly settings on brew, got %+v", ro)
	}
	if ctrl := smBrew.ControlToolService(context.Background(), "frpc", "stop"); !ctrl.OK {
		t.Fatalf("expected brew stop ok, got %+v", ctrl)
	}
}
