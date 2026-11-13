package apps

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

type recordedCall struct {
	command string
	args    []string
	env     map[string]string
}

type stubExecutor struct {
	mu      sync.Mutex
	calls   []recordedCall
	handler func(ctx context.Context, callIndex int, command string, args []string, opts environment.ExecOptions) environment.RunResult
}

func (s *stubExecutor) Run(ctx context.Context, command string, args []string, opts environment.ExecOptions) environment.RunResult {
	s.mu.Lock()
	idx := len(s.calls)
	s.calls = append(s.calls, recordedCall{
		command: command,
		args:    append([]string(nil), args...),
		env:     opts.Env,
	})
	s.mu.Unlock()
	if s.handler != nil {
		return s.handler(ctx, idx, command, args, opts)
	}
	return environment.RunResult{OK: true}
}

func (s *stubExecutor) SnapshotCalls() []recordedCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]recordedCall, len(s.calls))
	copy(out, s.calls)
	return out
}

func writeFakeExecutable(t *testing.T, dir, name, content string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	target := filepath.Join(dir, name)
	if err := os.WriteFile(target, []byte(content), 0o755); err != nil {
		t.Fatalf("write executable %s: %v", target, err)
	}
	return target
}

func TestResolveTargetAndLifecyclePlans(t *testing.T) {
	tmp := t.TempDir()
	aiHome := filepath.Join(tmp, "aihome")
	dshProfileBin := filepath.Join(aiHome, "run", "harness", "dsh-tui", "acct_1")
	_ = writeFakeExecutable(t, dshProfileBin, "dsh", "#!/bin/sh\n")

	jm := NewJobManager(NewManager(), Options{
		Platform:    "linux",
		Arch:        "amd64",
		HostHomeDir: filepath.Join(tmp, "home"),
		AIHomeDir:   aiHome,
		Env:         map[string]string{"PATH": ""},
	})

	if target := ResolveInstallTarget(InstallInput{AppID: "codex-desktop"}); target == nil || target.Provider != "codex" || target.Kind != "desktop" || target.Action != "install" {
		t.Fatalf("unexpected codex-desktop target: %+v", target)
	}
	if target := ResolveInstallTarget(InstallInput{AppID: "vscode", Kind: "ide"}); target == nil || target.Provider != "vscode" || target.Kind != "desktop" {
		t.Fatalf("unexpected vscode target: %+v", target)
	}
	if target := ResolveInstallTarget(InstallInput{AppID: "codex", Action: "invalid"}); target != nil {
		t.Fatalf("expected nil for invalid action, got: %+v", target)
	}

	dshUpdate := jm.Plan(InstallInput{AppID: "dsh", Kind: "cli", Action: "update"})
	if !dshUpdate.OK || len(dshUpdate.Plans) < 2 {
		t.Fatalf("expected dsh update plans incl. dsh-tui profile, got: %+v", dshUpdate)
	}
	hasDshTui := false
	for _, p := range dshUpdate.Plans {
		if strings.HasPrefix(p.ID, "dsh_tui_profile_update:acct_1") {
			hasDshTui = true
		}
	}
	if !hasDshTui {
		t.Fatalf("expected dsh_tui_profile_update:acct_1 in plans: %+v", dshUpdate.Plans)
	}

	// workbuddy 没有自动安装计划，应返回清晰中文手动安装提示。
	hint := BuildDesktopInstallHint("workbuddy", Options{Platform: "linux"})
	if !strings.Contains(hint, "WorkBuddy") {
		t.Fatalf("unexpected manual hint for workbuddy: %q", hint)
	}

	// IDE 在 Linux 下生成官方仓库计划，在 Windows 下生成 Winget 计划。
	vscodeLinux := ResolveDesktopInstallPlans("vscode", Options{Platform: "linux", Arch: "amd64"})
	if len(vscodeLinux) == 0 {
		t.Fatal("expected vscode linux desktop install plans")
	}
	vscodeWin := ResolveDesktopInstallPlans("vscode", Options{Platform: "windows", Arch: "x64"})
	if len(vscodeWin) == 0 || vscodeWin[0].Command != "winget.exe" {
		t.Fatalf("expected vscode winget plan on windows, got: %+v", vscodeWin)
	}
}

func TestListManagedAppsCacheInvalidationAndVersionRefresh(t *testing.T) {
	tmp := t.TempDir()
	hostHome := filepath.Join(tmp, "home")
	aiHome := filepath.Join(tmp, "aihome")
	binDir := filepath.Join(tmp, "bin")
	codexBin := writeFakeExecutable(t, binDir, "codex", "#!/bin/sh\n")

	probeCalls := 0
	execStub := &stubExecutor{
		handler: func(_ context.Context, _ int, command string, args []string, _ environment.ExecOptions) environment.RunResult {
			if command == codexBin && len(args) == 1 && args[0] == "--version" {
				probeCalls++
				return environment.RunResult{OK: true, Stdout: "codex-cli 1.2.3\n"}
			}
			return environment.RunResult{OK: true}
		},
	}

	now := time.Unix(1700000000, 0)
	mgr := NewManager()
	opts := Options{
		Catalog:     nil,
		HostHomeDir: hostHome,
		AIHomeDir:   aiHome,
		Platform:    "linux",
		Arch:        "amd64",
		Env:         map[string]string{"HOME": hostHome, "PATH": binDir},
		LookPath: func(file string) (string, error) {
			if file == "codex" {
				return codexBin, nil
			}
			return "", os.ErrNotExist
		},
		Executor:      execStub,
		ProbeVersions: "sync",
		Now:           func() time.Time { return now },
	}

	// 1. 同步探测模式下可即时返回准确本地版本号。
	list := mgr.ListManagedApps(context.Background(), opts)
	if !list.OK || list.Total == 0 {
		t.Fatalf("expected non-empty apps list, got %+v", list)
	}
	var codexApp *AppView
	for i := range list.Apps {
		if list.Apps[i].ID == "codex" {
			codexApp = &list.Apps[i]
			break
		}
	}
	if codexApp == nil || !codexApp.Installed || codexApp.Version != "1.2.3" {
		t.Fatalf("expected codex installed v1.2.3, got: %+v", codexApp)
	}

	// 2. 默认缓存模式下，同一 TTL 内再次读取命中缓存，不再触发额外探针。
	cachedOpts := opts
	cachedOpts.ProbeVersions = ""
	cachedOpts.RefreshInventory = false
	_ = mgr.ListManagedApps(context.Background(), cachedOpts)
	afterFirstCached := probeCalls
	_ = mgr.ListManagedApps(context.Background(), cachedOpts)
	if probeCalls != afterFirstCached {
		t.Fatalf("expected cached inventory hit without extra probes (before=%d after=%d)", afterFirstCached, probeCalls)
	}

	// 3. InvalidateCache 后刷新单个应用版本可重新探测。
	mgr.InvalidateCache("")
	refreshed := mgr.RefreshManagedAppVersion(context.Background(), "codex", opts)
	if !refreshed.OK || refreshed.CurrentVersion == nil || *refreshed.CurrentVersion != "1.2.3" {
		t.Fatalf("unexpected refresh result: %+v", refreshed)
	}
}

func TestCheckManagedAppUpdateParsersAndNpmQuery(t *testing.T) {
	if got := ParseHomebrewCaskVersion(`{"casks":[{"version":"1.99.2,abc"}]}`); got != "1.99.2" {
		t.Fatalf("ParseHomebrewCaskVersion = %q", got)
	}
	if got := ParseWingetLatestVersion("Found Foo\r\nVersion: 2.4.1\r\nPublisher: Example"); got != "2.4.1" {
		t.Fatalf("ParseWingetLatestVersion = %q", got)
	}

	tmp := t.TempDir()
	binDir := filepath.Join(tmp, "bin")
	cliBin := writeFakeExecutable(t, binDir, "codex", "#!/bin/sh\n")
	execStub := &stubExecutor{
		handler: func(_ context.Context, _ int, command string, args []string, _ environment.ExecOptions) environment.RunResult {
			if command == cliBin {
				return environment.RunResult{OK: true, Stdout: "codex 1.0.0\n"}
			}
			if (command == "npm" || command == "npm.cmd") && len(args) >= 2 && args[0] == "view" {
				return environment.RunResult{OK: true, Stdout: "1.5.0\n"}
			}
			return environment.RunResult{OK: true}
		},
	}

	mgr := NewManager()
	res := mgr.CheckManagedAppUpdate(context.Background(), AppView{
		ID:            "codex",
		Provider:      "codex",
		Type:          "cli",
		CLIPath:       cliBin,
		Installed:     true,
		Version:       "1.0.0",
		VersionSource: &VersionSource{Type: "npm", PackageName: "@openai/codex"},
	}, Options{
		Platform:      "linux",
		HostHomeDir:   filepath.Join(tmp, "home"),
		Executor:      execStub,
		ProbeVersions: "sync",
	})
	if !res.OK || res.Status != "available" || !res.UpdateAvailable {
		t.Fatalf("expected update_available result, got: %+v", res)
	}
	if res.CurrentVersion == nil || *res.CurrentVersion != "1.0.0" || res.LatestVersion == nil || *res.LatestVersion != "1.5.0" {
		t.Fatalf("unexpected version pair: %+v", res)
	}
}

func TestHooksInstallDiagnoseAndUninstall(t *testing.T) {
	tmp := t.TempDir()
	hostHome := filepath.Join(tmp, "home")
	aiHome := filepath.Join(tmp, "aihome")
	senderScript := filepath.Join(tmp, "repo", "bin", "ai_home.js")
	if err := os.MkdirAll(filepath.Dir(senderScript), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(senderScript, []byte("// mock cli\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// 预先写入用户自定义 claude hook，校验安装与卸载均不会误删用户条目。
	claudeSettings := filepath.Join(hostHome, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(claudeSettings), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(claudeSettings, []byte(`{
  "hooks": {
    "Stop": [
      {"matcher": "", "hooks": [{"type": "command", "command": "/usr/local/bin/user-stop-hook"}]}
    ]
  }
}`), 0o644); err != nil {
		t.Fatal(err)
	}

	// 预先写入 codex [features] 并模拟 codex 0.114.0（应从 codex_hooks 切换为 hooks = true）。
	codexConfig := filepath.Join(hostHome, ".codex", "config.toml")
	if err := os.MkdirAll(filepath.Dir(codexConfig), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(codexConfig, []byte("[features]\ncodex_hooks = false\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	hookBinDir := filepath.Join(tmp, "bin")
	claudeBin := writeFakeExecutable(t, hookBinDir, "claude", "#!/bin/sh\n")
	codexBin := writeFakeExecutable(t, hookBinDir, "codex", "#!/bin/sh\n")
	agyBin := writeFakeExecutable(t, hookBinDir, "agy", "#!/bin/sh\n")
	opencodeBin := writeFakeExecutable(t, hookBinDir, "opencode", "#!/bin/sh\n")
	cliBins := map[string]string{
		"claude":   claudeBin,
		"codex":    codexBin,
		"agy":      agyBin,
		"opencode": opencodeBin,
	}
	execStub := &stubExecutor{
		handler: func(_ context.Context, _ int, command string, _ []string, _ environment.ExecOptions) environment.RunResult {
			if command == codexBin {
				return environment.RunResult{OK: true, Stdout: "codex-cli 0.114.0\n"}
			}
			return environment.RunResult{OK: true}
		},
	}

	mgr := NewManager()
	opts := Options{
		Catalog:     nil,
		HostHomeDir: hostHome,
		AIHomeDir:   aiHome,
		Platform:    "linux",
		// 显式钉住 XDG_CONFIG_HOME：安装器会合并进程 env，宿主若已设置该项，
		// opencode plugin 会写到 XDG 而不是测试断言用的 HOME/.config。
		Env: map[string]string{"HOME": hostHome, "PATH": hookBinDir, "XDG_CONFIG_HOME": filepath.Join(hostHome, ".config")},
		LookPath: func(name string) (string, error) {
			if p, ok := cliBins[name]; ok {
				return p, nil
			}
			return "", os.ErrNotExist
		},
		Executor:         execStub,
		SenderScriptPath: senderScript,
		NodeExecPath:     "/usr/local/bin/node",
		ReceiverURL:      "http://127.0.0.1:9527/v0/provider-sessions/hook",
	}

	resp := mgr.InstallAppHooks(context.Background(), []string{"claude", "codex", "agy", "opencode"}, opts)
	if !resp.OK || len(resp.Results) != 4 {
		t.Fatalf("expected all 4 hook installs ok, got: %+v", resp)
	}
	for _, r := range resp.Results {
		if !r.OK || !r.Installed || !r.Verified {
			t.Fatalf("hook install result failed for %s: %+v", r.Provider, r)
		}
	}

	// 验证 codex config.toml 已切换并启用 hooks = true。
	codexTomlBytes, _ := os.ReadFile(codexConfig)
	if !strings.Contains(string(codexTomlBytes), "hooks = true") {
		t.Fatalf("expected hooks = true in %s", string(codexTomlBytes))
	}

	// 验证 opencode 插件文件生成。
	pluginPath := openCodePluginFilePath(hostHome, opts.Env, "linux")
	if _, err := os.Stat(pluginPath); err != nil {
		t.Fatalf("expected opencode plugin file %s: %v", pluginPath, err)
	}

	// 卸载所有托管 hooks 并确认 claude 用户自定义 hook 仍保留。
	unResp := mgr.UninstallAppHooks(context.Background(), []string{"claude", "agy", "opencode"}, opts)
	if !unResp.OK {
		t.Fatalf("expected hook uninstall ok: %+v", unResp)
	}
	claudeAfter, _ := os.ReadFile(claudeSettings)
	if !strings.Contains(string(claudeAfter), "/usr/local/bin/user-stop-hook") {
		t.Fatalf("user hook was unexpectedly removed: %s", string(claudeAfter))
	}
	if strings.Contains(string(claudeAfter), managedHookMarker) {
		t.Fatalf("managed hook marker still present after uninstall: %s", string(claudeAfter))
	}
	if _, err := os.Stat(pluginPath); !os.IsNotExist(err) {
		t.Fatalf("expected opencode plugin removed, err=%v", err)
	}
}

func TestOpenManagedDesktopAppClaudeGateway(t *testing.T) {
	tmp := t.TempDir()
	hostHome := filepath.Join(tmp, "home")
	aiHome := filepath.Join(tmp, "aihome")
	if err := os.MkdirAll(aiHome, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(aiHome, "server-config.json"), []byte(`{"port":9876}`), 0o644); err != nil {
		t.Fatal(err)
	}
	fakeClaudeBin := writeFakeExecutable(t, filepath.Join(tmp, "bin"), "claude-desktop", "#!/bin/sh\n")

	var spawnedCmd string
	var spawnedArgs []string
	execStub := &stubExecutor{
		handler: func(_ context.Context, _ int, command string, args []string, _ environment.ExecOptions) environment.RunResult {
			if command == "which" && len(args) > 0 && args[0] == "claude-desktop" {
				return environment.RunResult{OK: true, Stdout: fakeClaudeBin + "\n"}
			}
			return environment.RunResult{OK: false}
		},
	}

	// 在测试临时 Catalog 下无需改动全局 DefaultCatalog，用 Linux which 查找即可，但 Claude Desktop 配置在 darwin/win32；此处模拟 darwin 测试 gateway + SpawnDetached。
	fakeApp := filepath.Join(hostHome, "Applications", "Claude.app")
	if err := os.MkdirAll(filepath.Join(fakeApp, "Contents", "MacOS"), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = writeFakeExecutable(t, filepath.Join(fakeApp, "Contents", "MacOS"), "Claude", "#!/bin/sh\n")

	res := OpenManagedDesktopApp(context.Background(), "claude-desktop", Options{
		Catalog:     nil,
		Platform:    "darwin",
		HostHomeDir: hostHome,
		AIHomeDir:   aiHome,
		Env:         map[string]string{"HOME": hostHome},
		Executor:    execStub,
		SpawnDetached: func(command string, args []string, env map[string]string) error {
			spawnedCmd = command
			spawnedArgs = append([]string(nil), args...)
			_ = env
			return nil
		},
	})
	if !res.OK || res.Status != "launched" || spawnedCmd != "open" || !slices.Contains(spawnedArgs, fakeApp) {
		t.Fatalf("unexpected OpenManagedDesktopApp result=%+v cmd=%q args=%v", res, spawnedCmd, spawnedArgs)
	}

	// 检查 Claude-3p 网关目录写入内容。
	profileDir := filepath.Join(hostHome, "Library", "Application Support", "Claude-3p")
	devRaw, err := os.ReadFile(filepath.Join(profileDir, "developer_settings.json"))
	if err != nil {
		t.Fatalf("read developer_settings.json: %v", err)
	}
	var devJSON map[string]any
	if err := json.Unmarshal(devRaw, &devJSON); err != nil || devJSON["allowDevTools"] != true {
		t.Fatalf("unexpected developer_settings.json: %s (%v)", string(devRaw), err)
	}
	cfgRaw, err := os.ReadFile(filepath.Join(profileDir, "claude_desktop_config.json"))
	if err != nil {
		t.Fatalf("read claude_desktop_config.json: %v", err)
	}
	var cfgJSON map[string]any
	if err := json.Unmarshal(cfgRaw, &cfgJSON); err != nil || cfgJSON["deploymentMode"] != "3p" {
		t.Fatalf("unexpected claude_desktop_config.json: %s (%v)", string(cfgRaw), err)
	}
}

func TestAppInstallJobManagerLifecycleAndRetries(t *testing.T) {
	tmp := t.TempDir()
	hostHome := filepath.Join(tmp, "home")
	binDir := filepath.Join(tmp, "bin")

	// 1. MinNodeVersion 检查拦截（pi 需要 Node >= 22.19.0）。
	mgrNodeGate := NewJobManager(NewManager(), Options{
		Platform:         "linux",
		HostHomeDir:      hostHome,
		NodeVersion:      "v20.11.0",
		VerifyRetries:    1,
		VerifyRetryDelay: 0,
		Executor:         &stubExecutor{},
	})
	piCh, cancelPi := mgrNodeGate.SubscribeAll()
	defer cancelPi()
	piStart := mgrNodeGate.Start(context.Background(), InstallInput{AppID: "pi", Kind: "cli", Action: "install"})
	if !piStart.OK || piStart.Job == nil {
		t.Fatalf("expected pi job created: %+v", piStart)
	}
	var piDone JobView
	deadline := time.After(2 * time.Second)
	for {
		select {
		case ev := <-piCh:
			if ev.Job != nil && ev.Job.ID == piStart.Job.ID && isJobTerminalStatus(ev.Job.Status) {
				piDone = *ev.Job
				goto checkedNodeGate
			}
		case <-deadline:
			t.Fatal("timed out waiting for pi node gate job")
		}
	}
checkedNodeGate:
	if piDone.Status != "failed" || !strings.Contains(piDone.Error, "22.19.0") {
		t.Fatalf("expected node gate failure, got: %+v", piDone)
	}

	// 2. OpenCode CLI 安装应先执行 legacy npm cleanup (opencode-ai) 再执行安装并校验 CLIPath。
	var installedCliPath string
	opencodeExec := &stubExecutor{
		handler: func(_ context.Context, _ int, command string, args []string, _ environment.ExecOptions) environment.RunResult {
			if strings.Contains(command, "npm") && len(args) > 0 && args[0] == "install" {
				installedCliPath = writeFakeExecutable(t, binDir, "opencode", "#!/bin/sh\n")
				return environment.RunResult{OK: true}
			}
			return environment.RunResult{OK: true}
		},
	}
	mgrOC := NewJobManager(NewManager(), Options{
		Platform:         "linux",
		HostHomeDir:      hostHome,
		NodeVersion:      "v22.21.0",
		VerifyRetries:    1,
		VerifyRetryDelay: 0,
		Env:              map[string]string{"HOME": hostHome, "PATH": binDir},
		LookPath: func(name string) (string, error) {
			if name == "opencode" && installedCliPath != "" {
				return installedCliPath, nil
			}
			return "", os.ErrNotExist
		},
		Executor: opencodeExec,
	})
	ocAll, cancelOC := mgrOC.SubscribeAll()
	defer cancelOC()
	ocStart := mgrOC.Start(context.Background(), InstallInput{AppID: "opencode", Kind: "cli", Action: "install"})
	if !ocStart.OK || ocStart.Job == nil {
		t.Fatalf("opencode start failed: %+v", ocStart)
	}
	// 同目标幂等复用。
	dup := mgrOC.Start(context.Background(), InstallInput{AppID: "opencode", Kind: "cli", Action: "install"})
	if dup.OK && dup.Job != nil && !isJobTerminalStatus(dup.Job.Status) && dup.Job.ID != ocStart.Job.ID {
		t.Fatalf("expected concurrent duplicate to reuse job id %s, got %s", ocStart.Job.ID, dup.Job.ID)
	}
	var ocDone JobView
	deadlineOC := time.After(3 * time.Second)
	for {
		select {
		case ev := <-ocAll:
			if ev.Job != nil && ev.Job.ID == ocStart.Job.ID && isJobTerminalStatus(ev.Job.Status) {
				ocDone = *ev.Job
				goto checkedOpenCode
			}
		case <-deadlineOC:
			t.Fatal("timed out waiting for opencode job")
		}
	}
checkedOpenCode:
	if ocDone.Status != "succeeded" || ocDone.Result == nil || !ocDone.Result.Installed || ocDone.Result.CLIPath == "" {
		t.Fatalf("expected opencode succeeded with cliPath, got: %+v", ocDone)
	}
	if len(ocDone.Attempts) < 2 || ocDone.Attempts[0].ID != "legacy_npm_cleanup" {
		t.Fatalf("expected legacy_npm_cleanup first attempt, got: %+v", ocDone.Attempts)
	}

	// 3. Desktop AIH_DESKTOP_INSTALLED_PATH + VerifyRetries 重试窗口测试。
	markerApp := filepath.Join(tmp, "custom-install", "Claude.app")
	verifySleeps := 0
	mgrDesktop := NewJobManager(NewManager(), Options{
		Platform:         "darwin",
		HostHomeDir:      hostHome,
		VerifyRetries:    2,
		VerifyRetryDelay: time.Millisecond,
		Sleep: func(_ context.Context, _ time.Duration) error {
			verifySleeps++
			// 第二次校验前落盘安装包（模拟安装器子进程延迟落地）。
			_ = os.MkdirAll(filepath.Join(markerApp, "Contents", "MacOS"), 0o755)
			_ = os.WriteFile(filepath.Join(markerApp, "Contents", "MacOS", "Claude"), []byte("#!/bin/sh\n"), 0o755)
			return nil
		},
		Executor: &stubExecutor{
			handler: func(_ context.Context, _ int, _ string, _ []string, _ environment.ExecOptions) environment.RunResult {
				return environment.RunResult{
					OK:     true,
					Stdout: "installing...\n" + installedPathMarker + `"` + markerApp + `"` + "\n",
				}
			},
		},
	})
	dCh, cancelD := mgrDesktop.SubscribeAll()
	defer cancelD()
	dStart := mgrDesktop.Start(context.Background(), InstallInput{AppID: "claude-desktop", Action: "install"})
	if !dStart.OK || dStart.Job == nil {
		t.Fatalf("desktop start failed: %+v", dStart)
	}
	var dDone JobView
	deadlineD := time.After(3 * time.Second)
	for {
		select {
		case ev := <-dCh:
			if ev.Job != nil && ev.Job.ID == dStart.Job.ID && isJobTerminalStatus(ev.Job.Status) {
				dDone = *ev.Job
				goto checkedDesktop
			}
		case <-deadlineD:
			t.Fatal("timed out waiting for desktop install job")
		}
	}
checkedDesktop:
	if dDone.Status != "succeeded" || verifySleeps != 1 || dDone.Result == nil || dDone.Result.ExecutablePath == "" {
		t.Fatalf("expected desktop retry succeeded (sleeps=%d), got: %+v", verifySleeps, dDone)
	}
}
