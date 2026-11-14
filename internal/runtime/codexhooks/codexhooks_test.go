package codexhooks

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/sessionevents"
)

func TestWrapperBuildersAndSubcommandParsing(t *testing.T) {
	t.Parallel()

	if got := FindCodexSubcommand([]string{"-c", "model=gpt-5", "--profile", "work", "resume", "abc"}); got != "resume" {
		t.Fatalf("FindCodexSubcommand = %q, 期望 resume", got)
	}
	if got := FindCodexSubcommand([]string{"--model=gpt-5", "--", "resume"}); got != "" {
		t.Fatalf("-- 后不应识别子命令, 实际 %q", got)
	}

	opts := WrapperOptions{
		NodeExecPath:                 "/usr/local/bin/node",
		HelperScriptPath:             "/opt/aih/proxy's.js",
		UpstreamBinaryPath:           "/usr/local/bin/codex.aih-original",
		StateFilePath:                "/tmp/ai_home/run/codex/cli-hook-state.json",
		RouteDefaultCLIThroughHelper: true,
	}

	posix := BuildCLIWrapperScript(opts)
	if !HasCLIWrapperMarkerLine(posix) {
		t.Fatalf("POSIX wrapper 缺少独立标记行:\n%s", posix)
	}
	if !strings.Contains(posix, CodexAppServerPassthroughEnv) {
		t.Fatalf("POSIX wrapper 缺少直通环境变量:\n%s", posix)
	}
	if !strings.Contains(posix, `HELPER='/opt/aih/proxy'\''s.js'`) {
		t.Fatalf("POSIX wrapper 单引号转义异常:\n%s", posix)
	}
	// 包含在路径注释里的同名子串绝不能误判为 wrapper 标记行。
	pnpmComment := "#!/bin/sh\n# cmd-shim-target=/tmp/aih-codex-cli-hook/codex.js\nexec node \"$@\"\n"
	if HasCLIWrapperMarkerLine(pnpmComment) {
		t.Fatal("路径注释中包含标记子串不应匹配独立标记行")
	}

	ps1 := BuildCLIWrapperScriptForTarget("C:\\bin\\codex.ps1", opts)
	if !HasCLIWrapperMarkerLine(ps1) || !strings.Contains(ps1, "#!/usr/bin/env pwsh") {
		t.Fatalf("PowerShell wrapper 异常:\n%s", ps1)
	}

	cmdOpts := WrapperOptions{
		NodeExecPath:       `C:\Program Files\nodejs\node.exe`,
		HelperScriptPath:   `C:\aih\helper.js`,
		UpstreamBinaryPath: `C:\npm\codex.aih-original.cmd`,
		StateFilePath:      `C:\ai_home\run\codex\cli-hook-state.json`,
	}
	cmd := BuildCLIWrapperScriptForTarget(`C:\npm\codex.cmd`, cmdOpts)
	if !HasCLIWrapperMarkerLine(cmd) {
		t.Fatalf("CMD wrapper 缺少 REM 标记行:\n%s", cmd)
	}
	if got := ReadCmdSetVariable(cmd, WrapperUpstreamVar); got != cmdOpts.UpstreamBinaryPath {
		t.Fatalf("ReadCmdSetVariable(UPSTREAM) = %q, 期望 %q", got, cmdOpts.UpstreamBinaryPath)
	}
	if !strings.Contains(cmd, "\r\n") {
		t.Fatal("CMD wrapper 应使用 CRLF 行尾")
	}

	// 验证 Windows .cmd hook 绕过直连 Node 启动解析（含别名链）。
	winDir := t.TempDir()
	nodeFake := filepath.Join(winDir, "node.exe")
	helperFake := filepath.Join(winDir, "proxy.js")
	stateFake := filepath.Join(winDir, "state.json")
	upstreamFake := filepath.Join(winDir, "codex.aih-original.cmd")
	if err := os.WriteFile(nodeFake, []byte("node"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(helperFake, []byte("// proxy"), 0o644); err != nil {
		t.Fatal(err)
	}
	canonicalCmd := filepath.Join(winDir, "canonical.cmd")
	aliasCmd := filepath.Join(winDir, "codex.cmd")
	canonicalBody := BuildCLIWrapperScriptForTarget(canonicalCmd, WrapperOptions{
		NodeExecPath:       nodeFake,
		HelperScriptPath:   helperFake,
		UpstreamBinaryPath: upstreamFake,
		StateFilePath:      stateFake,
	})
	if err := os.WriteFile(canonicalCmd, []byte(canonicalBody), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(aliasCmd, []byte(BuildAliasWrapperScript(aliasCmd, canonicalCmd)), 0o644); err != nil {
		t.Fatal(err)
	}
	launch := ResolveWindowsCodexHookLaunch(aliasCmd, []string{"-m", "o3", "resume", "t-1"}, "windows", nodeFake)
	if launch == nil {
		t.Fatal("期望解析到 WindowsHookLaunch，实际为 nil")
	}
	if launch.Command != nodeFake || launch.HookPath != canonicalCmd {
		t.Fatalf("WindowsHookLaunch 意外: %+v", launch)
	}
	if len(launch.Args) < 2 || launch.Args[1] != "--run-cli-resume" {
		t.Fatalf("WindowsHookLaunch 参数模式错误: %+v", launch.Args)
	}
	if appServer := ResolveWindowsCodexHookLaunch(aliasCmd, []string{"app-server"}, "windows", nodeFake); appServer != nil {
		t.Fatalf("app-server 子命令应返回 nil 维持直通, 实际 %+v", appServer)
	}
}

func TestExternalLauncherAndLaunchEnv(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	aiHome := filepath.Join(root, "ai_home")
	target := filepath.Join(aiHome, "run", "codex", "desktop-cli")
	upstream := filepath.Join(root, "ChatGPT.app", "Contents", "Resources", "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex")
	if err := os.MkdirAll(filepath.Dir(upstream), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(upstream, []byte("native-upstream"), 0o755); err != nil {
		t.Fatal(err)
	}

	wrapper := BuildCodexAppServerWrapperScript(WrapperMarkerDesktop, WrapperOptions{
		NodeExecPath:       "/usr/bin/node",
		HelperScriptPath:   "/opt/helper.js",
		UpstreamBinaryPath: upstream,
		StateFilePath:      filepath.Join(aiHome, "run", "codex", "desktop-hook-state.json"),
	})
	res, err := InstallExternalLauncher(ExternalLauncherOptions{
		TargetBinaryPath:   target,
		UpstreamBinaryPath: upstream,
		Wrapper:            wrapper,
	})
	if err != nil {
		t.Fatalf("InstallExternalLauncher 错误: %v", err)
	}
	if !res.OK || !res.Installed || !res.Updated {
		t.Fatalf("InstallExternalLauncher 结果意外: %+v", res)
	}

	// 未写 state 文件时 ReadDesktopLaunchEnv 返回空映射。
	if env := ReadDesktopLaunchEnv(aiHome); len(env) != 0 {
		t.Fatalf("无 state 时应返回空 env, 实际 %+v", env)
	}
	statePayload, _ := json.Marshal(map[string]any{
		"enabled":          true,
		"hookStrategy":     HookStrategyExternalLauncher,
		"targetBinaryPath": target,
	})
	if err := os.WriteFile(filepath.Join(aiHome, "run", "codex", "desktop-hook-state.json"), statePayload, 0o600); err != nil {
		t.Fatal(err)
	}
	env := ReadDesktopLaunchEnv(aiHome)
	if env["CODEX_CLI_PATH"] != target {
		t.Fatalf("CODEX_CLI_PATH = %q, 期望 %q", env["CODEX_CLI_PATH"], target)
	}
}

func TestDesktopHookServiceLifecycleAndIsolation(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	aiHome := filepath.Join(root, "ai_home")
	hostHome := filepath.Join(root, "host_home")
	helper := filepath.Join(root, "helper.js")
	if err := os.WriteFile(helper, []byte("// helper v1"), 0o644); err != nil {
		t.Fatal(err)
	}

	// 验证在隔离测试目录下即使宿主机 /Applications 存在也不会越界扫描系统目录。
	isoSvc := NewDesktopHookService(DesktopHookOptions{
		AIHomeDir:        aiHome,
		HostHomeDir:      hostHome,
		Platform:         "darwin",
		NodeExecPath:     "/usr/local/bin/node",
		HelperScriptPath: helper,
		ProcessHomeDir:   hostHome,
		OSUserHomeDir:    "/Users/real-someone-else",
	})
	if paths := isoSvc.ResolvePaths(); paths.BundlePath != "" || paths.Reason != "codex_app_not_found" {
		t.Fatalf("隔离宿主目录不得扫描真实 /Applications, 实际 paths=%+v", paths)
	}

	// 场景 1: macos-nested-cli（external-launcher）且保留已有的 desktopAccountRef。
	bundle := filepath.Join(hostHome, "Applications", "ChatGPT.app")
	nestedBin := filepath.Join(bundle, "Contents", "Resources", "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex")
	if err := os.MkdirAll(filepath.Dir(nestedBin), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(nestedBin, []byte("nested-binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	plist := `<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key><string>1.2026.1</string><key>CFBundleVersion</key><string>420</string></dict></plist>`
	if err := os.WriteFile(filepath.Join(bundle, "Contents", "Info.plist"), []byte(plist), 0o644); err != nil {
		t.Fatal(err)
	}

	var killed []int
	svc := NewDesktopHookService(DesktopHookOptions{
		AIHomeDir:               aiHome,
		HostHomeDir:             hostHome,
		Platform:                "darwin",
		NodeExecPath:            "/usr/local/bin/node",
		HelperScriptPath:        helper,
		ProviderHookReceiverURL: "http://127.0.0.1:4312/v0/webui/session-events/provider-hook",
		SelfPID:                 999,
		ReadCodexVersion: func(_ string) string {
			return "codex-cli 0.160.0"
		},
		ListProcesses: func() ([]ProcessInfo, error) {
			mainApp := filepath.Join(bundle, "Contents", "MacOS", "ChatGPT")
			target := filepath.Join(aiHome, "run", "codex", "desktop-cli")
			return []ProcessInfo{
				{PID: 100, ParentPID: 1, Command: mainApp},
				{PID: 200, ParentPID: 100, Command: target + " app-server"},
				{PID: 201, ParentPID: 200, Command: target + " app-server child"},
				{PID: 300, ParentPID: 1, Command: "/usr/local/bin/codex app-server"},
			}, nil
		},
		KillProcess: func(pid int) error {
			killed = append(killed, pid)
			return nil
		},
	})

	// 先钉选一个桌面账号，确认 Activate / Trace / Deactivate 均不会丢失该字段。
	pinRes := svc.SetDesktopAccountRef("codex/acct-pin-1")
	if !pinRes.OK || !pinRes.Changed || pinRes.DesktopAccountRef != "codex/acct-pin-1" {
		t.Fatalf("SetDesktopAccountRef 异常: %+v", pinRes)
	}

	actRes, err := svc.Activate()
	if err != nil {
		t.Fatalf("Activate 失败: %v", err)
	}
	if !actRes.OK || !actRes.Enabled || !actRes.Installed {
		t.Fatalf("Activate 结果意外: %+v", actRes)
	}
	if got := svc.GetDesktopAccountRef(); got != "codex/acct-pin-1" {
		t.Fatalf("Activate 不应丢失 desktopAccountRef, 实际 %q", got)
	}

	// 健康检查应无漂移。
	ensureRes, err := svc.EnsureInstalled()
	if err != nil {
		t.Fatalf("EnsureInstalled 失败: %v", err)
	}
	if !ensureRes.OK || !ensureRes.Healthy || ensureRes.Repaired {
		t.Fatalf("首次健康巡检应 healthy 且 repaired=false: %+v", ensureRes)
	}

	// 破坏外置启动器后再次 EnsureInstalled 应自动修复。
	if err := os.WriteFile(actRes.TargetBinaryPath, []byte("corrupted"), 0o755); err != nil {
		t.Fatal(err)
	}
	repairedRes, err := svc.EnsureInstalled()
	if err != nil {
		t.Fatalf("EnsureInstalled 修复失败: %v", err)
	}
	if !repairedRes.OK || !repairedRes.Repaired || len(repairedRes.DriftReasons) == 0 {
		t.Fatalf("篡改后应触发修复, 实际 %+v", repairedRes)
	}

	// 验证 trace 配置与进程重启根过滤。
	traceRes := svc.UpdateTraceConfig(DesktopTraceConfig{
		TraceRemoteControl: true,
		RemoteControlProxy: true,
	})
	if !traceRes.OK || !traceRes.Changed || !strings.HasSuffix(traceRes.TraceFile, "mobile-trace.jsonl") {
		t.Fatalf("UpdateTraceConfig 异常: %+v", traceRes)
	}
	restartRes := svc.RestartRunningAppServers()
	if restartRes.Count != 1 || len(killed) != 1 || killed[0] != 200 {
		t.Fatalf("应仅向根 app-server PID 200 发信号, 实际 restart=%+v killed=%v", restartRes, killed)
	}

	// 验证 Deactivate 后仍保留 desktopAccountRef，且 ClearDesktopAccountRef 按期望账号清理。
	svc.Deactivate()
	if got := svc.GetDesktopAccountRef(); got != "codex/acct-pin-1" {
		t.Fatalf("Deactivate 后应保留 desktopAccountRef, 实际 %q", got)
	}
	wrongClear := svc.ClearDesktopAccountRef("codex/other")
	if wrongClear.Changed || wrongClear.DesktopAccountRef != "codex/acct-pin-1" {
		t.Fatalf("不匹配的 ClearDesktopAccountRef 不应清除, 实际 %+v", wrongClear)
	}
	okClear := svc.ClearDesktopAccountRef("codex/acct-pin-1")
	if !okClear.OK || !okClear.Changed || svc.GetDesktopAccountRef() != "" {
		t.Fatalf("ClearDesktopAccountRef 失败: %+v", okClear)
	}
}

func TestVscodeHookServiceLifecycle(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	aiHome := filepath.Join(root, "ai_home")
	hostHome := filepath.Join(root, "host_home")
	extBin := filepath.Join(hostHome, ".vscode", "extensions", "openai.chatgpt-0.5.0", "bin", "macos-arm64", "codex")
	if err := os.MkdirAll(filepath.Dir(extBin), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(extBin, []byte("vscode-codex-native"), 0o755); err != nil {
		t.Fatal(err)
	}

	var killed []int
	svc := NewVscodeHookService(VscodeHookOptions{
		AIHomeDir:        aiHome,
		HostHomeDir:      hostHome,
		Platform:         "darwin",
		NodeExecPath:     "/usr/local/bin/node",
		HelperScriptPath: "/opt/helper.js",
		SelfPID:          888,
		ListProcesses: func() ([]ProcessInfo, error) {
			return []ProcessInfo{
				{PID: 51, Command: extBin + " app-server --analytics-default-enabled"},
				{PID: 52, Command: "/usr/bin/codex exec"},
			}, nil
		},
		KillProcess: func(pid int) error {
			killed = append(killed, pid)
			return nil
		},
	})

	res1 := svc.Activate()
	if !res1.OK || !res1.Enabled || res1.Installed != 1 || !res1.Changed {
		t.Fatalf("VSCode Activate 意外: %+v", res1)
	}
	if !svc.IsWrapperInstalled(extBin) || !fileExists(extBin+".aih-original") {
		t.Fatal("VSCode wrapper 或备份文件未创建")
	}

	res2 := svc.EnsureInstalled()
	if !res2.OK || res2.Changed || res2.Repaired {
		t.Fatalf("VSCode 二次 EnsureInstalled 应幂等无变化: %+v", res2)
	}

	restarted := svc.RestartRunningAppServers()
	if restarted.Count != 1 || len(killed) != 1 || killed[0] != 51 {
		t.Fatalf("VSCode app-server 重启异常: %+v killed=%v", restarted, killed)
	}
}

func TestCLIHookServiceBackupAliasAndCache(t *testing.T) {
	t.Parallel()
	if got := BuildBackupPath(`/npm/codex.cmd`); got != `/npm/codex.aih-original.cmd` {
		t.Fatalf("BuildBackupPath(.cmd) = %q", got)
	}
	if got := BuildBackupPath(`/npm/codex.ps1`); got != `/npm/codex.aih-original.ps1` {
		t.Fatalf("BuildBackupPath(.ps1) = %q", got)
	}
	if got := BuildBackupPath(`/usr/local/bin/codex`); got != `/usr/local/bin/codex.aih-original` {
		t.Fatalf("BuildBackupPath(posix) = %q", got)
	}

	root := t.TempDir()
	aiHome := filepath.Join(root, "ai_home")
	hostHome := filepath.Join(root, "host_home")
	canonicalDir := filepath.Join(root, "bin-primary")
	staleDir := filepath.Join(root, "bin-stale")
	if err := os.MkdirAll(canonicalDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(staleDir, 0o755); err != nil {
		t.Fatal(err)
	}
	canonicalBin := filepath.Join(canonicalDir, "codex")
	staleBin := filepath.Join(staleDir, "codex")
	if err := os.WriteFile(canonicalBin, []byte("#!/bin/sh\necho real-codex\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(staleBin, []byte("#!/bin/sh\n# aih-codex-cli-hook\necho stale\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 11, 13, 8, 0, 0, 0, time.UTC)
	var fullCalls int
	svc := NewCLIHookService(CLIHookOptions{
		AIHomeDir:        aiHome,
		HostHomeDir:      hostHome,
		Platform:         "darwin",
		Arch:             "arm64",
		PathEnv:          canonicalDir + string(os.PathListSeparator) + staleDir,
		TempDir:          root,
		NodeExecPath:     "/usr/local/bin/node",
		HelperScriptPath: "/opt/helper.js",
		Now:              func() time.Time { return now },
		ResolveCodexBinary: func(loginShellFallback bool) string {
			if loginShellFallback {
				fullCalls++
				return canonicalBin
			}
			return canonicalBin
		},
	})

	actRes := svc.Activate()
	if !actRes.OK || !actRes.Enabled || !actRes.Installed {
		t.Fatalf("CLI Activate 意外: %+v", actRes)
	}
	if !svc.IsWrapperInstalled(canonicalBin) || !fileExists(canonicalBin+".aih-original") {
		t.Fatal("CLI wrapper 或 .aih-original 备份未写入")
	}
	// 另一个 PATH 上的旧 wrapper 应被自动重指向别名。
	if !HasAliasWrapperMarkerLine(readTextFileSafe(staleBin)) {
		t.Fatalf("stale PATH 入口应被改写为 forwarding alias, 实际:\n%s", readTextFileSafe(staleBin))
	}

	state1, err := os.ReadFile(svc.StateFilePath())
	if err != nil {
		t.Fatal(err)
	}
	// 推进时钟后健康巡检，状态文件 updatedAt 不应抖动重写。
	now = now.Add(2 * time.Minute)
	ensureRes := svc.EnsureInstalled(CLIHookEnsureOptions{Background: true})
	if !ensureRes.OK || !ensureRes.Healthy || ensureRes.Repaired {
		t.Fatalf("CLI 健康巡检结果意外: %+v", ensureRes)
	}
	state2, err := os.ReadFile(svc.StateFilePath())
	if err != nil {
		t.Fatal(err)
	}
	if string(state1) != string(state2) {
		t.Fatalf("健康状态下 cli-hook-state.json 不应重复改写:\n%s\nvs\n%s", string(state1), string(state2))
	}

	// 验证后台 5 分钟缓存命中（模拟 fast scan 未命中，但 memo 未过期且目标仍存在）。
	var loginFallbacks int
	bgSvc := NewCLIHookService(CLIHookOptions{
		AIHomeDir:     aiHome,
		HostHomeDir:   hostHome,
		Platform:      "darwin",
		Now:           func() time.Time { return now },
		BackgroundTTL: 5 * time.Minute,
		ResolveCodexBinary: func(loginShellFallback bool) string {
			if !loginShellFallback {
				return ""
			}
			loginFallbacks++
			return canonicalBin
		},
	})
	_ = bgSvc.ResolvePaths(CLIHookEnsureOptions{Background: true})
	now = now.Add(1 * time.Minute)
	_ = bgSvc.ResolvePaths(CLIHookEnsureOptions{Background: true})
	if loginFallbacks != 1 {
		t.Fatalf("5 分钟内后台扫描命中缓存不应重复登录 shell 探测, loginFallbacks=%d", loginFallbacks)
	}
	now = now.Add(6 * time.Minute)
	_ = bgSvc.ResolvePaths(CLIHookEnsureOptions{Background: true})
	if loginFallbacks != 2 {
		t.Fatalf("缓存过期后应重新触发完整探测, loginFallbacks=%d", loginFallbacks)
	}
	_ = fullCalls
}

func TestSelfHealLoopBackoffAndSuspension(t *testing.T) {
	t.Parallel()
	expectedReported := map[int]bool{
		1: true, 2: true, 3: false, 4: true, 5: false, 6: false, 7: false, 8: true, 0: false,
	}
	for c, want := range expectedReported {
		if got := ShouldReportFailure(c); got != want {
			t.Fatalf("ShouldReportFailure(%d) = %v, 期望 %v", c, got, want)
		}
	}

	var mu sync.Mutex
	now := time.Date(2026, 11, 13, 9, 0, 0, 0, time.UTC)
	getNow := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return now
	}
	advance := func(d time.Duration) {
		mu.Lock()
		now = now.Add(d)
		mu.Unlock()
	}

	var mode atomic.Int32 // 0=retryable fail, 1=repaired, 2=non-retryable fail
	var failures []SelfHealFailure
	var repaired []SelfHealResult

	loop, err := StartSelfHealLoop(context.Background(), SelfHealOptions{
		Interval:   10 * time.Second,
		MaxBackoff: 60 * time.Second,
		Now:        getNow,
		EnsureInstalled: func(_ context.Context) (SelfHealResult, error) {
			switch mode.Load() {
			case 0:
				return SelfHealResult{OK: false, Reason: "temp_fail"}, nil
			case 1:
				return SelfHealResult{OK: true, Repaired: true, TargetBinaryPath: "/tmp/codex"}, nil
			default:
				f := false
				return SelfHealResult{OK: false, Retryable: &f, Reason: "hook_target_not_writable", ErrorCode: "EACCES"}, nil
			}
		},
		OnRepaired: func(r SelfHealResult) {
			mu.Lock()
			repaired = append(repaired, r)
			mu.Unlock()
		},
		OnFailure: func(f SelfHealFailure) {
			mu.Lock()
			failures = append(failures, f)
			mu.Unlock()
		},
	})
	if err != nil {
		t.Fatalf("StartSelfHealLoop 失败: %v", err)
	}
	defer loop.Stop()

	// 第 1 次失败：退避 10s，并上报 (count=1)。
	loop.Tick(context.Background())
	// 退避期内的 Tick 被跳过。
	if skipped := loop.Tick(context.Background()); skipped != nil {
		t.Fatalf("退避期内不应重试, 实际 %+v", skipped)
	}
	advance(10 * time.Second)
	// 第 2 次失败：退避 20s，并上报 (count=2)。
	loop.Tick(context.Background())
	// 第 3 次失败（20s 后）：退避 40s，不触发 OnFailure (count=3)。
	advance(20 * time.Second)
	loop.Tick(context.Background())

	mu.Lock()
	failCount := len(failures)
	mu.Unlock()
	if failCount != 2 {
		t.Fatalf("幂次抑制后 OnFailure 应被调用 2 次 (第1/2次), 实际 %d", failCount)
	}

	// 恢复成功应归零失败计数并触发 OnRepaired。
	advance(40 * time.Second)
	mode.Store(1)
	loop.Tick(context.Background())
	st := loop.State()
	if st.ConsecutiveFailures != 0 || st.Suspended {
		t.Fatalf("恢复后状态异常: %+v", st)
	}
	mu.Lock()
	repairedLen := len(repaired)
	mu.Unlock()
	if repairedLen != 1 {
		t.Fatalf("OnRepaired 应被调用 1 次, 实际 %d", repairedLen)
	}

	// 不可重试错误立即挂起并上报。
	mode.Store(2)
	loop.Tick(context.Background())
	st = loop.State()
	if !st.Suspended {
		t.Fatalf("Retryable=false 后应立即挂起, 实际 %+v", st)
	}
	if res := loop.Tick(context.Background()); res != nil {
		t.Fatalf("挂起后 Tick 应返回 nil, 实际 %+v", res)
	}

	loop.Stop()
	loop.Stop() // 验证幂等停止
}

func TestNotificationQueueAndBridge(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	aiHome := filepath.Join(root, "ai_home")

	// 过滤非 codex 与空 sessionId。
	if _, ok := SanitizeNotificationEvent(NotificationEvent{Provider: "claude", SessionID: "s1"}, time.Now); ok {
		t.Fatal("非 codex 事件应被拒绝")
	}
	if _, ok := SanitizeNotificationEvent(NotificationEvent{Provider: "codex"}, time.Now); ok {
		t.Fatal("空 sessionId 事件应被拒绝")
	}

	// 验证有界写入与低水位裁切 + 偏移量追踪。
	q := NewNotificationQueue(NotificationQueueOptions{
		AIHomeDir: aiHome,
		MaxBytes:  900,
	})
	for i := 0; i < 12; i++ {
		ok, _ := q.Append(NotificationEvent{
			Provider:  "codex",
			SessionID: "thr-bounded",
			Type:      "session:turn-completed",
			Source:    "test",
			At:        int64(1700000000000 + i),
		})
		if !ok {
			t.Fatalf("第 %d 次 Append 失败", i)
		}
	}
	info, err := os.Stat(q.FilePath())
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() > 900 {
		t.Fatalf("队列文件超出上限: size=%d > 900", info.Size())
	}
	readRes := q.ReadSince(0, DefaultNotificationMaxReadBytes)
	if len(readRes.Events) == 0 || readRes.Offset == 0 {
		t.Fatalf("ReadSince 应读取到完整尾行, 实际 %+v", readRes)
	}

	// 测试双向 Bridge：Go sessionevents.Bus <-> 队列文件（并发访问 -race）。
	bus := sessionevents.NewBus(sessionevents.BusOptions{Debounce: 10 * time.Millisecond})
	defer bus.Close()

	ch, _, unsubBus := bus.Subscribe(sessionevents.Session{
		Provider:  "codex",
		SessionID: "thr-bridge",
	}, false)
	defer unsubBus()

	bridgeQueueFile := filepath.Join(root, "bridge.jsonl")
	startAtEnd := false
	bridge := NewNotificationBridge(NotificationBridgeOptions{
		QueueFile:    bridgeQueueFile,
		Bus:          bus,
		PollInterval: 15 * time.Millisecond,
		StartAtEnd:   &startAtEnd,
	})
	var listenerMu sync.Mutex
	var listenerGot []NotificationEvent
	unsubList := bridge.AddListener(func(ev NotificationEvent) {
		listenerMu.Lock()
		listenerGot = append(listenerGot, ev)
		listenerMu.Unlock()
	})
	defer unsubList()

	bridge.Start(context.Background())
	defer bridge.Stop()

	// Go 侧发布不会自激循环，且立即通知内部监听者与落盘。
	if !bridge.PublishSessionEvent(sessionevents.Session{
		Provider:  "codex",
		SessionID: "thr-bridge",
	}, sessionevents.Event{
		Type:   "session:started",
		Source: "go-hook",
		At:     1700000000100,
	}) {
		t.Fatal("PublishSessionEvent 失败")
	}

	// 模拟外部进程直接写入一行通知，验证 Bridge 自动消费并投递到 Go Bus。
	extQueue := NewNotificationQueue(NotificationQueueOptions{QueueFile: bridgeQueueFile})
	okExt, _ := extQueue.Append(NotificationEvent{
		Provider:  "codex",
		SessionID: "thr-bridge",
		Type:      "session:external-turn",
		Source:    "stdio-proxy",
		At:        1700000000200,
	})
	if !okExt {
		t.Fatal("外部写入队列失败")
	}

	select {
	case got := <-ch:
		if got.Type != "session:external-turn" || got.Source != "stdio-proxy" {
			t.Fatalf("Go sessionevents.Bus 收到意外事件: %+v", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("等待 Bridge 把外部通知转发至 Go sessionevents.Bus 超时")
	}

	listenerMu.Lock()
	gotCount := len(listenerGot)
	listenerMu.Unlock()
	if gotCount < 2 {
		t.Fatalf("监听者应至少收到内部发布和外部队列各一条事件, 实际 %d", gotCount)
	}
}

func TestCLIHookDefaultResolveCodexBinary(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	pathDir := filepath.Join(root, "path-bin")
	hostHome := filepath.Join(root, "host-home")
	userDir := filepath.Join(hostHome, ".npm-global", "bin")
	if err := os.MkdirAll(pathDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(userDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// PATH 上不可执行的同名文件应被跳过，转而命中用户目录安装路径。
	nonExec := filepath.Join(pathDir, "codex")
	if err := os.WriteFile(nonExec, []byte("#!/bin/sh\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	userBin := filepath.Join(userDir, "codex")
	if err := os.WriteFile(userBin, []byte("#!/bin/sh\necho ok\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	svc := NewCLIHookService(CLIHookOptions{
		AIHomeDir:   filepath.Join(root, "ai_home"),
		HostHomeDir: hostHome,
		Platform:    "darwin",
		PathEnv:     pathDir,
	})
	if got := svc.defaultResolveCodexBinary(false); got != userBin {
		t.Fatalf("defaultResolveCodexBinary(false) = %q, want %q", got, userBin)
	}

	// 删除用户目录入口并保留显式 PathEnv 时，不得越界命中宿主机真实二进制。
	if err := os.Remove(userBin); err != nil {
		t.Fatal(err)
	}
	if got := svc.defaultResolveCodexBinary(true); got != "" {
		t.Fatalf("隔离 PathEnv 场景未找到时应返回空, 实际 %q", got)
	}
}

func TestDesktopHookFreshInstallLeavesNoUpstreamFingerprintDrift(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	aiHome := filepath.Join(root, "ai_home")
	hostHome := filepath.Join(root, "host_home")
	helper := filepath.Join(root, "helper.js")
	if err := os.WriteFile(helper, []byte("// helper\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	bundlePath := filepath.Join(hostHome, "Applications", "Codex.app")
	targetBin := filepath.Join(bundlePath, "Contents", "Resources", "codex")
	if err := os.MkdirAll(filepath.Dir(targetBin), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(targetBin, []byte("#!/bin/sh\necho upstream\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	allowSys := false
	layouts := []DesktopLayout{
		{
			ID:            "test-in-place",
			Platform:      "darwin",
			BinarySubpath: filepath.Join("Contents", "Resources", "codex"),
		},
	}
	svc := NewDesktopHookService(DesktopHookOptions{
		AIHomeDir:               aiHome,
		HostHomeDir:             hostHome,
		Platform:                "darwin",
		NodeExecPath:            "/usr/local/bin/node",
		HelperScriptPath:        helper,
		RuntimeLayouts:          layouts,
		AllowSystemApplications: &allowSys,
		ReadBundleMetadata: func(string) BundleMetadata {
			return BundleMetadata{AppVersion: "1.0.0", AppBuildVersion: "10"}
		},
		ReadCodexVersion: func(string) string { return "0.99.0" },
	})

	first, err := svc.Activate()
	if err != nil {
		t.Fatalf("first Activate() error = %v", err)
	}
	if !first.Enabled || !first.RestartRequired {
		t.Fatalf("unexpected first Activate() result: %+v", first)
	}
	if state := svc.ReadState(); state.UpstreamFingerprint == nil {
		t.Fatalf("expected UpstreamFingerprint to be recorded after fresh install: %+v", state)
	}

	second, err := svc.Activate()
	if err != nil {
		t.Fatalf("second Activate() error = %v", err)
	}
	if second.RestartRequired || len(second.DriftReasons) != 0 {
		t.Fatalf("second Activate() reported unexpected drift %v (restartRequired=%v)", second.DriftReasons, second.RestartRequired)
	}
	health, err := svc.EnsureInstalled()
	if err != nil {
		t.Fatalf("EnsureInstalled() error = %v", err)
	}
	if !health.Healthy || health.Repaired {
		t.Fatalf("expected healthy=true repaired=false after fresh install, got %+v", health)
	}
}
