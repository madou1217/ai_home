package webuiopenappapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/modelalias"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/hostapps"
	"github.com/madou1217/ai_home/internal/adapters/kimi/desktopsession"
	"github.com/madou1217/ai_home/internal/runtime/codexhooks"
)

func testBoolPtr(v bool) *bool { return &v }

type fakeAccountsPort struct {
	mu      sync.Mutex
	records map[string]AccountSnapshot
	updated map[string][]byte
}

func newFakeAccountsPort(items ...AccountSnapshot) *fakeAccountsPort {
	records := make(map[string]AccountSnapshot, len(items))
	for _, item := range items {
		key := strings.ToLower(item.Provider) + ":" + item.AccountRef.String()
		records[key] = item
	}
	return &fakeAccountsPort{
		records: records,
		updated: make(map[string][]byte),
	}
}

func (f *fakeAccountsPort) LookupAccount(_ context.Context, provider string, accountRef string) (AccountSnapshot, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	key := strings.ToLower(strings.TrimSpace(provider)) + ":" + strings.TrimSpace(accountRef)
	item, ok := f.records[key]
	return item, ok, nil
}

func (f *fakeAccountsPort) UpdateNativeCredential(_ context.Context, accountRef string, payload []byte, _ time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.updated[strings.TrimSpace(accountRef)] = append([]byte(nil), payload...)
	return nil
}

type fakeEgressPort struct {
	mu           sync.Mutex
	resolution   EgressResolution
	denied       bool
	deniedReason string
	checkedEnv   []string
	resolveCalls int
}

func (f *fakeEgressPort) Resolve(_ context.Context, _ string, _ string, _ string) EgressResolution {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.resolveCalls++
	if f.resolution.Error == "" && !f.resolution.OK {
		return EgressResolution{OK: true}
	}
	return f.resolution
}

func (f *fakeEgressPort) CheckLaunchNetwork(_ context.Context, _ string, _ string, _ string, env []string, _ EgressResolution) (bool, string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.checkedEnv = append([]string(nil), env...)
	return f.denied, f.deniedReason
}

type fakeModelAliasesPort struct {
	records []modelalias.Record
	err     error
}

func (f *fakeModelAliasesPort) ListAliases(_ context.Context) ([]modelalias.Record, error) {
	return f.records, f.err
}

type fakeCodexHooksPort struct {
	mu           sync.Mutex
	ensured      int
	setRefs      []string
	clearedRefs  []string
	restarted    int
	ensureResult codexhooks.DesktopHookResult
	ensureErr    error
}

func (f *fakeCodexHooksPort) EnsureInstalled() (codexhooks.DesktopHookResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ensured++
	return f.ensureResult, f.ensureErr
}

func (f *fakeCodexHooksPort) SetDesktopAccountRef(accountRef string) codexhooks.AccountRefMutationResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.setRefs = append(f.setRefs, accountRef)
	// 模拟首次写入：引用确实发生变化，调用方应触发 app-server 重启。
	return codexhooks.AccountRefMutationResult{OK: true, Changed: true, DesktopAccountRef: accountRef}
}

func (f *fakeCodexHooksPort) ClearDesktopAccountRef(expectedRef string) codexhooks.AccountRefMutationResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.clearedRefs = append(f.clearedRefs, expectedRef)
	return codexhooks.AccountRefMutationResult{OK: true, DesktopAccountRef: expectedRef}
}

func (f *fakeCodexHooksPort) RestartRunningAppServers() codexhooks.RestartAppServersResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.restarted++
	return codexhooks.RestartAppServersResult{OK: true}
}

type fakeProcessScanner struct {
	desktops []hostapps.DesktopInstance
	clis     []hostapps.CLIInstance
	err      error
}

func (f *fakeProcessScanner) ListDesktopInstances(_ context.Context) ([]hostapps.DesktopInstance, error) {
	return f.desktops, f.err
}

func (f *fakeProcessScanner) ListCLIInstances(_ context.Context) ([]hostapps.CLIInstance, error) {
	return f.clis, f.err
}

type fakeCommandRunner struct {
	mu          sync.Mutex
	runs        []string
	spawns      []SpawnSpec
	closedCalls [][]int
	nextPID     int
	spawnErr    error
	spawnDelay  time.Duration
	aliveSet    map[int]bool
	killSet     []int
	runHandler  func(name string, args []string, opts RunOptions) RunOutput
}

func newFakeCommandRunner() *fakeCommandRunner {
	return &fakeCommandRunner{
		nextPID:  4100,
		aliveSet: make(map[int]bool),
	}
}

func (r *fakeCommandRunner) Run(_ context.Context, name string, args []string, opts RunOptions) RunOutput {
	r.mu.Lock()
	r.runs = append(r.runs, name+" "+strings.Join(args, " "))
	handler := r.runHandler
	r.mu.Unlock()
	if handler != nil {
		return handler(name, args, opts)
	}
	return RunOutput{ExitCode: 0}
}

func (r *fakeCommandRunner) StartDetached(spec SpawnSpec) (int, error) {
	if r.spawnDelay > 0 {
		time.Sleep(r.spawnDelay)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.spawns = append(r.spawns, spec)
	if r.spawnErr != nil {
		return 0, r.spawnErr
	}
	r.nextPID++
	return r.nextPID, nil
}

func (r *fakeCommandRunner) IsProcessAlive(pid int) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.aliveSet[pid]
}

func (r *fakeCommandRunner) CloseProcessTree(_ context.Context, pids []int, _ time.Duration, _ func(context.Context, time.Duration) error) ([]int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closedCalls = append(r.closedCalls, append([]int(nil), pids...))
	if r.killSet != nil {
		return append([]int(nil), r.killSet...), nil
	}
	return append([]int(nil), pids...), nil
}

type fakeKimiSessionPort struct {
	mu      sync.Mutex
	session desktopsession.Session
	found   bool
	err     error
	written []desktopsession.Session
}

func (f *fakeKimiSessionPort) ReadSession(_ context.Context, _ string) (desktopsession.Session, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.session, f.found, f.err
}

func (f *fakeKimiSessionPort) WriteSession(_ context.Context, _ string, session desktopsession.Session) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.session = session
	f.found = true
	f.written = append(f.written, session)
	return nil
}

func mustRef(t *testing.T, raw string) accountcore.AccountRef {
	t.Helper()
	ref, err := accountcore.ParseAccountRef(raw)
	if err != nil {
		t.Fatalf("ParseAccountRef(%q): %v", raw, err)
	}
	return ref
}

func makeFakeJWT(expUnix int64) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256"}`))
	payload, _ := json.Marshal(map[string]int64{"exp": expUnix})
	body := base64.RawURLEncoding.EncodeToString(payload)
	return header + "." + body + ".sig"
}

func baseTestEnv(hostHome string) []string {
	return []string{
		"HOME=" + hostHome,
		"PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
		"SSH_CONNECTION=1.2.3.4 22 5.6.7.8 22",
	}
}

func envLookup(env []string, key string) (string, bool) {
	for _, entry := range env {
		k, v, ok := strings.Cut(entry, "=")
		if ok && k == key {
			return v, true
		}
	}
	return "", false
}

func noopSleep(_ context.Context, _ time.Duration) error { return nil }

func TestNativeLauncherAccountEligibilityAndPlatformGuards(t *testing.T) {
	t.Parallel()
	now := time.Unix(1750000000, 0)
	aiHome := t.TempDir()
	hostHome := t.TempDir()
	cat := newTestCatalog(t)

	expiredJWT := makeFakeJWT(now.Add(-5 * time.Minute).Unix())
	accounts := newFakeAccountsPort(
		AccountSnapshot{
			AccountRef: mustRef(t, "acct_00000000000000000001"),
			Provider:   "codex",
			Configured: false,
		},
		AccountSnapshot{
			AccountRef:  mustRef(t, "acct_00000000000000000002"),
			Provider:    "codex",
			Configured:  true,
			AuthInvalid: true,
		},
		AccountSnapshot{
			AccountRef:     mustRef(t, "acct_00000000000000000003"),
			Provider:       "zcode",
			Configured:     true,
			NativeAuthJSON: json.RawMessage(`{"credentials":{"oauth:zai:access_token":"` + expiredJWT + `"}}`),
		},
		AccountSnapshot{
			AccountRef:     mustRef(t, "acct_00000000000000000004"),
			Provider:       "codebuddy",
			Configured:     true,
			NativeAuthJSON: json.RawMessage(`{"credentials":{"access_token":"tok"}}`),
		},
	)

	launcher := NewNativeLauncher(NativeLauncherDependencies{
		AIHomeDir:      aiHome,
		HostHomeDir:    hostHome,
		Platform:       "darwin",
		Catalog:        cat,
		Accounts:       accounts,
		Runner:         newFakeCommandRunner(),
		ProcessScanner: &fakeProcessScanner{},
		Now:            func() time.Time { return now },
		Sleep:          noopSleep,
		Environ:        func() []string { return baseTestEnv(hostHome) },
	})

	cases := []struct {
		name    string
		req     Request
		wantErr string
	}{
		{
			name:    "unknown account",
			req:     Request{Provider: "codex", AccountRef: "acct_missing000000000000", Kind: "cli", Action: "open"},
			wantErr: "account_not_found",
		},
		{
			name:    "unconfigured account",
			req:     Request{Provider: "codex", AccountRef: "acct_00000000000000000001", Kind: "cli", Action: "open"},
			wantErr: "account_unconfigured",
		},
		{
			name:    "auth invalid account",
			req:     Request{Provider: "codex", AccountRef: "acct_00000000000000000002", Kind: "desktop", Action: "open"},
			wantErr: "account_auth_invalid",
		},
		{
			name:    "zcode expired desktop JWT",
			req:     Request{Provider: "zcode", AccountRef: "acct_00000000000000000003", Kind: "desktop", Action: "open"},
			wantErr: "account_auth_invalid",
		},
		{
			name:    "codebuddy missing uid",
			req:     Request{Provider: "codebuddy", AccountRef: "acct_00000000000000000004", Kind: "cli", Action: "open"},
			wantErr: "account_auth_invalid",
		},
		{
			name:    "desktop unsupported provider",
			req:     Request{Provider: "gemini", AccountRef: "", Kind: "desktop", Action: "open"},
			wantErr: "desktop_not_supported",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res, err := launcher.Launch(context.Background(), tc.req)
			if err != nil {
				t.Fatalf("Launch error: %v", err)
			}
			if res.OK || res.Error != tc.wantErr {
				t.Fatalf("got (%+v), want error=%q", res, tc.wantErr)
			}
		})
	}
}

func TestNativeLauncherInstallRequiredDesktopAndCLI(t *testing.T) {
	t.Parallel()
	aiHome := t.TempDir()
	hostHome := t.TempDir()
	cat := newTestCatalog(t)
	ref := mustRef(t, "acct_00000000000000000010")
	accounts := newFakeAccountsPort(AccountSnapshot{
		AccountRef:   ref,
		Provider:     "codex",
		CLIAccountID: 7,
		Configured:   true,
	})
	launcher := NewNativeLauncher(NativeLauncherDependencies{
		AIHomeDir:        aiHome,
		HostHomeDir:      hostHome,
		Platform:         "darwin",
		Catalog:          cat,
		Accounts:         accounts,
		Runner:           newFakeCommandRunner(),
		ProcessScanner:   &fakeProcessScanner{},
		DesktopAppFinder: func(context.Context, string, string) *DesktopAppRecord { return nil },
		CLIBinaryFinder:  func(context.Context, string, string, string) string { return "" },
		InstallChecker: func(provider, kind, appID string) bool {
			return provider == "codex" && kind == "cli"
		},
		Sleep:   noopSleep,
		Environ: func() []string { return baseTestEnv(hostHome) },
	})

	desktopRes, err := launcher.Launch(context.Background(), Request{
		Provider:   "codex",
		AccountRef: ref.String(),
		Kind:       "desktop",
		Action:     "open",
	})
	if err != nil {
		t.Fatalf("desktop Launch: %v", err)
	}
	if desktopRes.OK || desktopRes.Error != "desktop_not_installed" || !desktopRes.InstallRequired {
		t.Fatalf("unexpected desktop install_required result: %+v", desktopRes)
	}
	if desktopRes.InstallTarget == nil || desktopRes.InstallTarget.AppID != "codex-desktop" || desktopRes.InstallAvailable == nil || *desktopRes.InstallAvailable {
		t.Fatalf("unexpected desktop InstallTarget/Available: %+v", desktopRes)
	}

	cliRes, err := launcher.Launch(context.Background(), Request{
		Provider:   "codex",
		AccountRef: ref.String(),
		Kind:       "cli",
		Action:     "open",
		Transport:  "native",
	})
	if err != nil {
		t.Fatalf("cli Launch: %v", err)
	}
	if cliRes.OK || cliRes.Error != "cli_not_installed" || !cliRes.InstallRequired {
		t.Fatalf("unexpected cli install_required result: %+v", cliRes)
	}
	if cliRes.InstallTarget == nil || cliRes.InstallTarget.AppID != "codex" || cliRes.InstallAvailable == nil || !*cliRes.InstallAvailable {
		t.Fatalf("unexpected cli InstallTarget/Available: %+v", cliRes)
	}
}

func TestApplyAccountEgressProxyEnvKeepsBothCases(t *testing.T) {
	t.Parallel()
	// 未绑定出口：宿主只留了小写写法时，必须补出大写，反之亦然。
	base := []string{"https_proxy=http://127.0.0.1:18080", "HOME=/tmp/x"}
	got := applyAccountEgressProxyEnv("codex", base, EgressResolution{})
	for _, key := range []string{"HTTPS_PROXY", "https_proxy"} {
		if value, _ := envLookup(got, key); value != "http://127.0.0.1:18080" {
			t.Fatalf("%s = %q, want mirrored proxy", key, value)
		}
	}

	// 绑定代理：四种写法都要写成解析出的出口。
	bound := applyAccountEgressProxyEnv("codex", []string{"HOME=/tmp/x"}, EgressResolution{
		OK: true, Bound: true, ProxyServer: "http://127.0.0.1:19000",
	})
	for _, key := range []string{"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"} {
		if value, _ := envLookup(bound, key); value != "http://127.0.0.1:19000" {
			t.Fatalf("%s = %q, want bound proxy", key, value)
		}
	}

	// zcode：统一清空，大小写都不能残留。
	zcode := applyAccountEgressProxyEnv("zcode", []string{
		"HTTPS_PROXY=http://a:1", "https_proxy=http://a:1", "HTTP_PROXY=http://a:1", "http_proxy=http://a:1",
	}, EgressResolution{OK: true, Bound: true, ProxyServer: "http://b:2"})
	for _, key := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"} {
		if _, exists := envLookup(zcode, key); exists {
			t.Fatalf("zcode must clear %s", key)
		}
	}
}

func TestNativeLauncherEgressFailClosedAndProxyDecoration(t *testing.T) {
	t.Parallel()
	aiHome := t.TempDir()
	hostHome := t.TempDir()
	cat := newTestCatalog(t)
	runner := newFakeCommandRunner()

	desktopExe := filepath.Join(t.TempDir(), "Codex.app", "Contents", "MacOS", "Codex")
	if err := os.MkdirAll(filepath.Dir(desktopExe), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(desktopExe, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	cliExe := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(cliExe, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	ref := mustRef(t, "acct_00000000000000000011")
	accounts := newFakeAccountsPort(AccountSnapshot{
		AccountRef:   ref,
		Provider:     "codex",
		CLIAccountID: 9,
		Configured:   true,
	})

	egress := &fakeEgressPort{
		resolution: EgressResolution{
			OK:      false,
			Bound:   true,
			Error:   "account_egress_unavailable",
			Reason:  "socks5 port unreachable",
			Warning: "warn",
		},
	}

	launcher := NewNativeLauncher(NativeLauncherDependencies{
		AIHomeDir:      aiHome,
		HostHomeDir:    hostHome,
		Platform:       "darwin",
		Catalog:        cat,
		Accounts:       accounts,
		Egress:         egress,
		CodexHooks:     &fakeCodexHooksPort{},
		Runner:         runner,
		ProcessScanner: &fakeProcessScanner{},
		DesktopAppFinder: func(context.Context, string, string) *DesktopAppRecord {
			return &DesktopAppRecord{
				Provider:       "codex",
				BundlePath:     filepath.Dir(filepath.Dir(filepath.Dir(desktopExe))),
				ExecutablePath: desktopExe,
			}
		},
		CLIBinaryFinder: func(context.Context, string, string, string) string { return cliExe },
		Sleep:           noopSleep,
		Environ:         func() []string { return baseTestEnv(hostHome) },
	})

	res, err := launcher.Launch(context.Background(), Request{
		Provider:   "codex",
		AccountRef: ref.String(),
		Kind:       "desktop",
		Action:     "open",
	})
	if err != nil {
		t.Fatalf("Launch: %v", err)
	}
	if res.OK || res.Error != "account_egress_unavailable" || res.EgressError != "socks5 port unreachable" {
		t.Fatalf("expected egress fail-closed, got %+v", res)
	}
	if len(runner.spawns) != 0 {
		t.Fatalf("should not spawn on egress failure, spawns=%d", len(runner.spawns))
	}

	egress.mu.Lock()
	egress.resolution = EgressResolution{
		OK:          true,
		Bound:       true,
		Source:      "proxy",
		ProxyServer: "http://127.0.0.1:18080",
	}
	egress.denied = true
	egress.deniedReason = "US blocked"
	egress.mu.Unlock()

	res, err = launcher.Launch(context.Background(), Request{
		Provider:   "codex",
		AccountRef: ref.String(),
		Kind:       "desktop",
		Action:     "open",
	})
	if err != nil {
		t.Fatalf("Launch region denied: %v", err)
	}
	if res.OK || res.Error != "account_egress_region_denied" || res.Reason != "US blocked" {
		t.Fatalf("expected account_egress_region_denied, got %+v", res)
	}
	if len(runner.spawns) != 0 {
		t.Fatalf("should not spawn on region denial, spawns=%d", len(runner.spawns))
	}

	egress.mu.Lock()
	egress.denied = false
	egress.resolution = EgressResolution{
		OK:          true,
		Bound:       true,
		Source:      "proxy",
		ProxyServer: "http://127.0.0.1:18080",
		Warning:     "出口处于观测警告",
	}
	egress.mu.Unlock()

	res, err = launcher.Launch(context.Background(), Request{
		Provider:   "codex",
		AccountRef: ref.String(),
		Kind:       "desktop",
		Action:     "open",
	})
	if err != nil || !res.OK {
		t.Fatalf("Launch proxy allowed: res=%+v err=%v", res, err)
	}
	if res.EgressWarning != "出口处于观测警告" {
		t.Fatalf("missing EgressWarning: %+v", res)
	}
	lastSpawn := runner.spawns[len(runner.spawns)-1]
	// 大小写两份都必须落到 spawn 环境：客户端只读其中一种写法。
	for _, key := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"} {
		if gotProxy, _ := envLookup(lastSpawn.Env, key); gotProxy != "http://127.0.0.1:18080" {
			t.Fatalf("%s mismatch: %q", key, gotProxy)
		}
	}
	for _, key := range []string{"NO_PROXY", "no_proxy"} {
		if gotNoProxy, _ := envLookup(lastSpawn.Env, key); !strings.Contains(gotNoProxy, "127.0.0.1") {
			t.Fatalf("%s must contain loopback, got %q", key, gotNoProxy)
		}
	}
	if !slices.Contains(lastSpawn.Args, "--proxy-server=http://127.0.0.1:18080") {
		t.Fatalf("expected --proxy-server arg, got %v", lastSpawn.Args)
	}

	egress.mu.Lock()
	egress.resolution = EgressResolution{
		OK:     true,
		Bound:  true,
		Source: "external_tun",
		Direct: true,
	}
	egress.mu.Unlock()
	res, err = launcher.Launch(context.Background(), Request{
		Provider:   "codex",
		AccountRef: ref.String(),
		Kind:       "desktop",
		Action:     "open",
	})
	if err != nil || !res.OK {
		t.Fatalf("Launch direct TUN: res=%+v err=%v", res, err)
	}
	lastSpawn = runner.spawns[len(runner.spawns)-1]
	if !slices.Contains(lastSpawn.Args, "--no-proxy-server") {
		t.Fatalf("expected --no-proxy-server arg, got %v", lastSpawn.Args)
	}
}

func TestNativeLauncherCodexDesktopOpenSingleFlightReuseAndClose(t *testing.T) {
	t.Parallel()
	aiHome := t.TempDir()
	hostHome := t.TempDir()
	cat := newTestCatalog(t)
	runner := newFakeCommandRunner()
	runner.spawnDelay = 30 * time.Millisecond

	hooks := &fakeCodexHooksPort{}
	scanner := &fakeProcessScanner{}
	desktopExe := filepath.Join(t.TempDir(), "Codex.app", "Contents", "MacOS", "Codex")
	if err := os.MkdirAll(filepath.Dir(desktopExe), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(desktopExe, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	ref := mustRef(t, "acct_00000000000000000012")
	accounts := newFakeAccountsPort(AccountSnapshot{
		AccountRef:     ref,
		Provider:       "codex",
		Configured:     true,
		APIKeyMode:     true,
		AuthMode:       "apikey",
		BaseURL:        "https://codex.example.invalid/v1",
		NativeAuthJSON: json.RawMessage(`{"OPENAI_API_KEY":"sk-test-codex-123"}`),
	})

	launcher := NewNativeLauncher(NativeLauncherDependencies{
		AIHomeDir:      aiHome,
		HostHomeDir:    hostHome,
		Platform:       "darwin",
		Catalog:        cat,
		Accounts:       accounts,
		CodexHooks:     hooks,
		Runner:         runner,
		ProcessScanner: scanner,
		DesktopAppFinder: func(context.Context, string, string) *DesktopAppRecord {
			return &DesktopAppRecord{
				Provider:       "codex",
				ExecutablePath: desktopExe,
			}
		},
		Sleep:   noopSleep,
		Environ: func() []string { return baseTestEnv(hostHome) },
	})

	var wg sync.WaitGroup
	results := make([]Result, 2)
	errs := make([]error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			results[idx], errs[idx] = launcher.Launch(context.Background(), Request{
				Provider:   "codex",
				AccountRef: ref.String(),
				Kind:       "desktop",
				Action:     "open",
			})
		}(i)
	}
	wg.Wait()
	for i := 0; i < 2; i++ {
		if errs[i] != nil || !results[i].OK || results[i].Status != "launched" {
			t.Fatalf("concurrent open[%d] failed: res=%+v err=%v", i, results[i], errs[i])
		}
	}
	if len(runner.spawns) != 1 {
		t.Fatalf("expected single-flight 1 spawn, got %d", len(runner.spawns))
	}
	if hooks.ensured != 1 || hooks.restarted != 1 || len(hooks.setRefs) != 1 || hooks.setRefs[0] != ref.String() {
		t.Fatalf("unexpected codex hook calls: ensured=%d restarted=%d setRefs=%v", hooks.ensured, hooks.restarted, hooks.setRefs)
	}

	profileDir := hostapps.ProfileDir(aiHome, "codex", ref.String())
	if _, err := os.Stat(filepath.Join(profileDir, ".codex", "config.toml")); err != nil {
		t.Fatalf("expected codex config.toml written: %v", err)
	}
	if _, err := os.Stat(filepath.Join(profileDir, ".codex", "auth.json")); err != nil {
		t.Fatalf("expected codex auth.json written: %v", err)
	}

	userDataDir := hostapps.UserDataDir(aiHome, "codex", ref.String())
	scanner.desktops = []hostapps.DesktopInstance{{
		PID:         9911,
		UserDataDir: userDataDir,
	}}
	reuseRes, err := launcher.Launch(context.Background(), Request{
		Provider:   "codex",
		AccountRef: ref.String(),
		Kind:       "desktop",
		Action:     "open",
	})
	if err != nil || !reuseRes.OK || reuseRes.Status != "already_running" {
		t.Fatalf("expected already_running, got res=%+v err=%v", reuseRes, err)
	}

	closeRes, err := launcher.Launch(context.Background(), Request{
		Provider:   "codex",
		AccountRef: ref.String(),
		Kind:       "desktop",
		Action:     "close",
	})
	if err != nil || !closeRes.OK || closeRes.Status != "closed" {
		t.Fatalf("expected closed, got res=%+v err=%v", closeRes, err)
	}
	if !slices.Equal(closeRes.PIDs, []int{9911}) {
		t.Fatalf("unexpected closed PIDs: %v", closeRes.PIDs)
	}
	if len(hooks.clearedRefs) != 1 || hooks.clearedRefs[0] != ref.String() {
		t.Fatalf("expected ClearDesktopAccountRef called, got %v", hooks.clearedRefs)
	}
}

func TestNativeLauncherAgyKimiClaudeCodebuddyAndKiroStrategies(t *testing.T) {
	t.Parallel()
	aiHome := t.TempDir()
	hostHome := t.TempDir()
	cat := newTestCatalog(t)
	runner := newFakeCommandRunner()
	scanner := &fakeProcessScanner{}
	kimiSessions := &fakeKimiSessionPort{found: false}

	keychainPath := filepath.Join(t.TempDir(), "login.keychain-db")
	runner.runHandler = func(name string, args []string, opts RunOptions) RunOutput {
		// 生产用绝对路径调 /usr/bin/security，按 basename 匹配。
		if filepath.Base(name) == "security" && len(args) > 0 && args[0] == "default-keychain" {
			return RunOutput{ExitCode: 0, Stdout: `    "` + keychainPath + `"` + "\n"}
		}
		return RunOutput{ExitCode: 0}
	}

	binDir := t.TempDir()
	makeApp := func(name string) string {
		p := filepath.Join(binDir, name+".app", "Contents", "MacOS", name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		return p
	}
	agyExe := makeApp("Antigravity")
	kimiExe := makeApp("Kimi")
	claudeExe := makeApp("Claude")
	kiroExe := makeApp("Kiro")
	cbExe := makeApp("CodeBuddy")

	agyRef := mustRef(t, "acct_00000000000000000021")
	kimiRef := mustRef(t, "acct_00000000000000000022")
	claudeRef := mustRef(t, "acct_00000000000000000023")
	kiroRef := mustRef(t, "acct_00000000000000000024")
	cbRef := mustRef(t, "acct_00000000000000000025")

	accounts := newFakeAccountsPort(
		AccountSnapshot{AccountRef: agyRef, Provider: "agy", Configured: true},
		AccountSnapshot{AccountRef: kimiRef, Provider: "kimi", Configured: true},
		AccountSnapshot{AccountRef: claudeRef, Provider: "claude", Configured: true, APIKeyMode: true},
		AccountSnapshot{AccountRef: kiroRef, Provider: "kiro", Configured: true},
		AccountSnapshot{
			AccountRef:     cbRef,
			Provider:       "codebuddy",
			Configured:     true,
			NativeAuthJSON: json.RawMessage(`{"access_token":"cb-tok","uid":"u123"}`),
		},
	)

	launcher := NewNativeLauncher(NativeLauncherDependencies{
		AIHomeDir:      aiHome,
		HostHomeDir:    hostHome,
		Platform:       "darwin",
		Catalog:        cat,
		Accounts:       accounts,
		Runner:         runner,
		ProcessScanner: scanner,
		KimiSessions:   kimiSessions,
		DesktopAppFinder: func(_ context.Context, provider, _ string) *DesktopAppRecord {
			switch provider {
			case "agy":
				return &DesktopAppRecord{Provider: "agy", ExecutablePath: agyExe, BundlePath: filepath.Dir(filepath.Dir(filepath.Dir(agyExe)))}
			case "kimi":
				return &DesktopAppRecord{Provider: "kimi", ExecutablePath: kimiExe, BundlePath: filepath.Dir(filepath.Dir(filepath.Dir(kimiExe)))}
			case "claude":
				return &DesktopAppRecord{Provider: "claude", ExecutablePath: claudeExe, BundlePath: filepath.Dir(filepath.Dir(filepath.Dir(claudeExe)))}
			case "kiro":
				return &DesktopAppRecord{Provider: "kiro", ExecutablePath: kiroExe, BundlePath: filepath.Dir(filepath.Dir(filepath.Dir(kiroExe)))}
			case "codebuddy":
				return &DesktopAppRecord{Provider: "codebuddy", ExecutablePath: cbExe, BundlePath: filepath.Dir(filepath.Dir(filepath.Dir(cbExe)))}
			default:
				return nil
			}
		},
		Sleep:   noopSleep,
		Environ: func() []string { return baseTestEnv(hostHome) },
	})

	agyRes, err := launcher.Launch(context.Background(), Request{
		Provider:   "agy",
		AccountRef: agyRef.String(),
		Kind:       "desktop",
		Action:     "open",
	})
	if err != nil || !agyRes.OK || agyRes.Status != "launched" {
		t.Fatalf("agy Launch: res=%+v err=%v", agyRes, err)
	}
	agySpawn := runner.spawns[len(runner.spawns)-1]
	// AGY 走文件凭据投影：必须把继承来的 SSH_CONNECTION 换成本机回环值，
	// 让 CLI 认为处于远程会话、绕开 macOS Keychain。
	if gotSSH, _ := envLookup(agySpawn.Env, "SSH_CONNECTION"); gotSSH != "127.0.0.1 12345 127.0.0.1 22" {
		t.Fatalf("AGY must override SSH_CONNECTION to loopback, got %q", gotSSH)
	}

	kimiFail, err := launcher.Launch(context.Background(), Request{
		Provider:   "kimi",
		AccountRef: kimiRef.String(),
		Kind:       "desktop",
		Action:     "open",
	})
	if err != nil {
		t.Fatalf("kimi required: %v", err)
	}
	if kimiFail.OK || kimiFail.Error != "kimi_desktop_session_required" {
		t.Fatalf("expected kimi_desktop_session_required, got %+v", kimiFail)
	}
	reqAction, ok := kimiFail.RequiredAction.(map[string]any)
	if !ok || reqAction["kind"] != "desktop-login" || reqAction["flow"] != "kimi-desktop-session" {
		t.Fatalf("unexpected kimi RequiredAction: %#v", kimiFail.RequiredAction)
	}

	kimiSessions.mu.Lock()
	kimiSessions.found = true
	kimiSessions.session = desktopsession.Session{
		AccessToken:  "kimi-access-123",
		RefreshToken: "kimi-refresh-456",
		UserID:       "kimi-user-1",
		UpdatedAtMS:  1750000000000,
	}
	kimiSessions.mu.Unlock()
	kimiUserData := hostapps.UserDataDir(aiHome, "kimi", kimiRef.String())
	scanner.desktops = []hostapps.DesktopInstance{{
		PID:         7721,
		UserDataDir: kimiUserData,
	}}
	kimiRes, err := launcher.Launch(context.Background(), Request{
		Provider:   "kimi",
		AccountRef: kimiRef.String(),
		Kind:       "desktop",
		Action:     "open",
	})
	if err != nil || !kimiRes.OK || kimiRes.Status != "launched" {
		t.Fatalf("kimi Launch with session: res=%+v err=%v", kimiRes, err)
	}
	if len(runner.closedCalls) == 0 || !slices.Equal(runner.closedCalls[len(runner.closedCalls)-1], []int{7721}) {
		t.Fatalf("expected kimi to close stale PID 7721 before launch, got %v", runner.closedCalls)
	}
	// Kimi Desktop 的托管会话落在 bridge-store/token-store.json（Node 同口径）。
	tokenStore := filepath.Join(kimiUserData, "bridge-store", "token-store.json")
	rawStore, err := os.ReadFile(tokenStore)
	if err != nil {
		t.Fatalf("expected kimi token store seeded at %s: %v", tokenStore, err)
	}
	if !strings.Contains(string(rawStore), "kimi-refresh-456") {
		t.Fatalf("expected seeded refresh token in %s, got %s", tokenStore, rawStore)
	}

	claudeRes, err := launcher.Launch(context.Background(), Request{
		Provider:   "claude",
		AccountRef: claudeRef.String(),
		Kind:       "desktop",
		Action:     "open",
	})
	if err != nil || !claudeRes.OK || claudeRes.Status != "launched" {
		t.Fatalf("claude Launch: res=%+v err=%v", claudeRes, err)
	}

	kiroRes, err := launcher.Launch(context.Background(), Request{
		Provider:   "kiro",
		AccountRef: kiroRef.String(),
		Kind:       "desktop",
		Action:     "open",
	})
	if err != nil || !kiroRes.OK || kiroRes.Status != "launched" {
		t.Fatalf("kiro Launch: res=%+v err=%v", kiroRes, err)
	}

	cbRes, err := launcher.Launch(context.Background(), Request{
		Provider:   "codebuddy",
		AccountRef: cbRef.String(),
		Kind:       "desktop",
		Action:     "open",
	})
	if err != nil || !cbRes.OK || cbRes.Status != "launched" {
		t.Fatalf("codebuddy Launch: res=%+v err=%v", cbRes, err)
	}
}

func TestNativeLauncherZcodeProxySettingsAndNoChromiumProxy(t *testing.T) {
	t.Parallel()
	aiHome := t.TempDir()
	hostHome := t.TempDir()
	cat := newTestCatalog(t)
	runner := newFakeCommandRunner()

	zcodeExe := filepath.Join(t.TempDir(), "ZCode.app", "Contents", "MacOS", "ZCode")
	if err := os.MkdirAll(filepath.Dir(zcodeExe), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(zcodeExe, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	ref := mustRef(t, "acct_00000000000000000031")
	accounts := newFakeAccountsPort(AccountSnapshot{
		AccountRef: ref,
		Provider:   "zcode",
		Configured: true,
	})
	egress := &fakeEgressPort{
		resolution: EgressResolution{
			OK:          true,
			Bound:       true,
			Source:      "proxy",
			ProxyServer: "socks5://127.0.0.1:10808",
		},
	}

	launcher := NewNativeLauncher(NativeLauncherDependencies{
		AIHomeDir:      aiHome,
		HostHomeDir:    hostHome,
		Platform:       "darwin",
		Catalog:        cat,
		Accounts:       accounts,
		Egress:         egress,
		Runner:         runner,
		ProcessScanner: &fakeProcessScanner{},
		DesktopAppFinder: func(context.Context, string, string) *DesktopAppRecord {
			return &DesktopAppRecord{Provider: "zcode", ExecutablePath: zcodeExe}
		},
		Sleep:   noopSleep,
		Environ: func() []string { return append(baseTestEnv(hostHome), "HTTPS_PROXY=http://stale:8080") },
	})

	res, err := launcher.Launch(context.Background(), Request{
		Provider:   "zcode",
		AccountRef: ref.String(),
		Kind:       "desktop",
		Action:     "open",
	})
	if err != nil || !res.OK {
		t.Fatalf("zcode Launch: res=%+v err=%v", res, err)
	}
	profileDir := hostapps.ProfileDir(aiHome, "zcode", ref.String())
	settingsBytes, err := os.ReadFile(filepath.Join(profileDir, ".zcode", "v2", "setting.json"))
	if err != nil {
		t.Fatalf("read zcode setting.json: %v", err)
	}
	var settingsMap map[string]any
	if err := json.Unmarshal(settingsBytes, &settingsMap); err != nil {
		t.Fatal(err)
	}
	if settingsMap["httpProxy"] != "socks5://127.0.0.1:10808" {
		t.Fatalf("unexpected zcode httpProxy: %#v", settingsMap)
	}
	markerPath := filepath.Join(profileDir, ".aih-zcode-egress.json")
	if _, err := os.Stat(markerPath); err != nil {
		t.Fatalf("expected zcode marker: %v", err)
	}
	lastSpawn := runner.spawns[len(runner.spawns)-1]
	if _, hasHTTPS := envLookup(lastSpawn.Env, "HTTPS_PROXY"); hasHTTPS {
		t.Fatalf("zcode must strip proxy env vars")
	}
	for _, arg := range lastSpawn.Args {
		if strings.HasPrefix(arg, "--proxy-server=") {
			t.Fatalf("zcode must not pass --proxy-server arg: %v", lastSpawn.Args)
		}
	}

	egress.mu.Lock()
	egress.resolution = EgressResolution{OK: true, Bound: false, Direct: true}
	egress.mu.Unlock()
	res, err = launcher.Launch(context.Background(), Request{
		Provider:   "zcode",
		AccountRef: ref.String(),
		Kind:       "desktop",
		Action:     "open",
	})
	if err != nil || !res.OK {
		t.Fatalf("zcode direct Launch: res=%+v err=%v", res, err)
	}
	settingsBytes, _ = os.ReadFile(filepath.Join(profileDir, ".zcode", "v2", "setting.json"))
	settingsMap = map[string]any{}
	_ = json.Unmarshal(settingsBytes, &settingsMap)
	if _, stillHas := settingsMap["httpProxy"]; stillHas {
		t.Fatalf("expected httpProxy removed after switch to direct: %#v", settingsMap)
	}
	if _, err := os.Stat(markerPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected marker removed after direct switch, stat err=%v", err)
	}

	if err := os.WriteFile(markerPath, []byte(`{"version":999}`), 0o600); err != nil {
		t.Fatal(err)
	}
	res, err = launcher.Launch(context.Background(), Request{
		Provider:   "zcode",
		AccountRef: ref.String(),
		Kind:       "desktop",
		Action:     "open",
	})
	if err != nil {
		t.Fatalf("corrupt marker Launch: %v", err)
	}
	if res.OK || res.Error != "zcode_native_proxy_marker_unrecognized" {
		t.Fatalf("expected zcode_native_proxy_marker_unrecognized, got %+v", res)
	}
}

func TestNativeLauncherCLIOpenCloseWebUIAliasesAndHTTP428(t *testing.T) {
	t.Parallel()
	aiHome := t.TempDir()
	hostHome := t.TempDir()
	workdir := t.TempDir()
	cat := newTestCatalog(t)
	runner := newFakeCommandRunner()

	codexCLI := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(codexCLI, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	claudeCLI := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(claudeCLI, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	cliRef := mustRef(t, "acct_00000000000000000041")
	crossRef := mustRef(t, "acct_00000000000000000042")
	accounts := newFakeAccountsPort(
		AccountSnapshot{
			AccountRef:   cliRef,
			Provider:     "codex",
			CLIAccountID: 42,
			Configured:   true,
		},
		AccountSnapshot{
			AccountRef:   crossRef,
			Provider:     "codex",
			CLIAccountID: 43,
			Configured:   true,
		},
	)
	aliases := &fakeModelAliasesPort{
		records: []modelalias.Record{
			{Alias: "fast-codex", Provider: "codex", TargetProvider: "codex", Target: "gpt-5-codex", Enabled: testBoolPtr(true)},
			{Alias: "wrong-target", Provider: "codex", TargetProvider: "claude", Target: "claude-sonnet-4", Enabled: testBoolPtr(true)},
		},
	}

	var openedWebUI []WebUITerminalOpenRequest
	scanner := &fakeProcessScanner{
		clis: []hostapps.CLIInstance{{
			Provider:   "codex",
			AccountRef: cliRef.String(),
			PID:        8812,
		}},
	}
	launcher := NewNativeLauncher(NativeLauncherDependencies{
		AIHomeDir:      aiHome,
		HostHomeDir:    hostHome,
		RepoRoot:       "/repo",
		Platform:       "darwin",
		Catalog:        cat,
		Accounts:       accounts,
		ModelAliases:   aliases,
		Runner:         runner,
		ProcessScanner: scanner,
		CLIBinaryFinder: func(_ context.Context, harness, _ string, _ string) string {
			if harness == "claude" {
				return claudeCLI
			}
			return codexCLI
		},
		WebUITerminalOpener: func(_ context.Context, req WebUITerminalOpenRequest) (WebUITerminalOpenResult, error) {
			openedWebUI = append(openedWebUI, req)
			return WebUITerminalOpenResult{
				TermID:     "term-1",
				SessionKey: req.SessionKey,
				Reused:     len(openedWebUI) == 2,
			}, nil
		},
		Sleep:   noopSleep,
		Environ: func() []string { return baseTestEnv(hostHome) },
	})

	res, err := launcher.Launch(context.Background(), Request{
		Provider:      "codex",
		AccountRef:    crossRef.String(),
		Kind:          "cli",
		Action:        "open",
		Harness:       "claude",
		CrossProvider: true,
		Model:         "fast-codex",
		Workdir:       workdir,
		Transport:     "webui",
		SessionKey:    "aih-term:" + crossRef.String() + ":claude",
	})
	if err != nil || !res.OK || res.Status != "launched" || res.LaunchMode != "webui-pty" {
		t.Fatalf("webui PTY open failed: res=%+v err=%v", res, err)
	}
	wantArgs := []string{filepath.Join("/repo", "bin", "ai-home.js"), "claude", crossRef.String(), "--model", "gpt-5-codex"}
	if !slices.Equal(openedWebUI[0].Args, wantArgs) {
		t.Fatalf("unexpected webui PTY args: got=%v want=%v", openedWebUI[0].Args, wantArgs)
	}
	if marker, _ := envLookup(openedWebUI[0].Env, "AIH_ACCOUNT_APP"); marker != "1" {
		t.Fatalf("expected AIH_ACCOUNT_APP=1 in webui env")
	}

	reuseRes, err := launcher.Launch(context.Background(), Request{
		Provider:   "codex",
		AccountRef: cliRef.String(),
		Kind:       "cli",
		Action:     "open",
		Workdir:    workdir,
		Transport:  "webui",
		SessionKey: "aih-term:" + cliRef.String() + ":codex",
	})
	if err != nil || !reuseRes.OK || reuseRes.Status != "already_running" {
		t.Fatalf("expected already_running on reused webui PTY, got res=%+v err=%v", reuseRes, err)
	}

	mismatchRes, err := launcher.Launch(context.Background(), Request{
		Provider:      "codex",
		AccountRef:    crossRef.String(),
		Kind:          "cli",
		Action:        "open",
		Harness:       "claude",
		CrossProvider: true,
		Model:         "wrong-target",
		Transport:     "webui",
		SessionKey:    "k",
	})
	if err != nil || mismatchRes.OK || mismatchRes.Error != "model_alias_target_provider_mismatch" {
		t.Fatalf("expected model_alias_target_provider_mismatch, got res=%+v err=%v", mismatchRes, err)
	}

	nativeCLIRes, err := launcher.Launch(context.Background(), Request{
		Provider:   "codex",
		AccountRef: cliRef.String(),
		Kind:       "cli",
		Action:     "open",
		TerminalID: "system-default",
		Workdir:    workdir,
		Transport:  "native",
	})
	if err != nil || !nativeCLIRes.OK || nativeCLIRes.Status != "launched" || nativeCLIRes.PID == nil {
		t.Fatalf("native CLI open failed: res=%+v err=%v", nativeCLIRes, err)
	}

	closeRes, err := launcher.Launch(context.Background(), Request{
		Provider:   "codex",
		AccountRef: cliRef.String(),
		Kind:       "cli",
		Action:     "close",
	})
	if err != nil || !closeRes.OK || closeRes.Status != "closed" || !slices.Equal(closeRes.PIDs, []int{8812}) {
		t.Fatalf("expected CLI close of [8812], got res=%+v err=%v", closeRes, err)
	}

	unscopedRes, err := launcher.Launch(context.Background(), Request{
		Provider:   "claude",
		Kind:       "cli",
		Action:     "open",
		Workdir:    workdir,
		Transport:  "webui",
		SessionKey: "aih-term::claude",
	})
	if err != nil || !unscopedRes.OK || unscopedRes.LaunchMode != "webui-pty" {
		t.Fatalf("expected unscoped webui PTY open OK, got res=%+v err=%v", unscopedRes, err)
	}
	if got := openedWebUI[len(openedWebUI)-1]; got.File != claudeCLI || len(got.Args) != 0 {
		t.Fatalf("expected unscoped webui PTY to launch %q with empty args, got file=%q args=%v", claudeCLI, got.File, got.Args)
	}

	installMissingLauncher := NewNativeLauncher(NativeLauncherDependencies{
		AIHomeDir:       aiHome,
		HostHomeDir:     hostHome,
		Platform:        "darwin",
		Catalog:         cat,
		Accounts:        accounts,
		CLIBinaryFinder: func(context.Context, string, string, string) string { return "" },
		InstallChecker:  func(provider, kind, appID string) bool { return true },
		Sleep:           noopSleep,
		Environ:         func() []string { return baseTestEnv(hostHome) },
	})
	appHandler := newTestHandler(t, Dependencies{
		Authorizer:  stubAuthorizer(true),
		Accounts:    stubAccounts{byRef: map[string]accountcore.Account{cliRef.String(): newTestAccount(t, cat, cliRef.String(), "codex")}},
		Providers:   cat,
		AIHomeDir:   aiHome,
		HostHomeDir: hostHome,
		Launcher:    installMissingLauncher,
		LookPath:    stubLookPath(map[string]string{}),
		DesktopHost: func() bool { return true },
	})
	rec := doRequest(t, appHandler, http.MethodPost, openAppTarget("codex", cliRef.String()), `{"kind":"cli","transport":"native"}`, "127.0.0.1:5555")
	if rec.Code != http.StatusPreconditionRequired {
		t.Fatalf("expected HTTP 428 install_required, got %d body=%s", rec.Code, rec.Body.String())
	}
	decoded := decodeResponse(t, rec)
	if !decoded.InstallRequired || decoded.InstallAvailable == nil || !*decoded.InstallAvailable {
		t.Fatalf("expected InstallRequired=true InstallAvailable=true in 428 response, got %+v", decoded)
	}
}
