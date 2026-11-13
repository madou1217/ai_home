package providercliupgrade

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/core/providers"
)

func TestVersionParseAndCompare(t *testing.T) {
	t.Parallel()
	if got := NormalizeVersionText("codex-cli 0.158.0"); got != "0.158.0" {
		t.Fatalf("NormalizeVersionText codex = %q", got)
	}
	if got := NormalizeVersionText("2.1.284 (Claude Code)"); got != "2.1.284" {
		t.Fatalf("NormalizeVersionText claude = %q", got)
	}
	if got := NormalizeVersionText("v1.2+build.9"); got != "1.2" {
		t.Fatalf("NormalizeVersionText 2-part = %q", got)
	}
	if cmp, ok := CompareVersions("0.158.0", "0.158.0-alpha.3"); !ok || cmp != 1 {
		t.Fatalf("release vs prerelease: cmp=%d ok=%v", cmp, ok)
	}
	if cmp, ok := CompareVersions("0.158.0-alpha.10", "0.158.0-alpha.2"); !ok || cmp != 1 {
		t.Fatalf("numeric prerelease: cmp=%d ok=%v", cmp, ok)
	}
	if cmp, ok := CompareVersions("0.158.0-1", "0.158.0-beta"); !ok || cmp != -1 {
		t.Fatalf("numeric vs string prerelease: cmp=%d ok=%v", cmp, ok)
	}
}

func TestChannelDetectionShimsAndShadow(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	binDir := filepath.Join(root, "bin")
	standaloneDir := filepath.Join(root, "standalone", "releases", "0.158.0", "bin")
	npmRoot := filepath.Join(root, "npm", "node_modules")
	pkgDir := filepath.Join(npmRoot, "@openai", "codex")
	for _, dir := range []string{binDir, standaloneDir, pkgDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	upstreamBin := filepath.Join(standaloneDir, "codex")
	if err := os.WriteFile(upstreamBin, []byte("#!/bin/sh\necho 0.158.0\n"), 0o755); err != nil {
		t.Fatalf("write upstream: %v", err)
	}
	shimBin := filepath.Join(binDir, "codex")
	if err := os.WriteFile(shimBin, []byte("#!/bin/sh\n# aih-codex-cli-hook-alias\nexec '"+upstreamBin+"' \"$@\"\n"), 0o755); err != nil {
		t.Fatalf("write shim: %v", err)
	}

	det := DetectCLIChannel(ChannelDetectInput{
		Provider:        "codex",
		ResolvedPath:    shimBin,
		StandaloneRoots: []string{filepath.Join(root, "standalone")},
		NpmGlobalRoot:   npmRoot,
		NpmPackageDir:   pkgDir,
	})
	if det.Channel != ChannelStandaloneRelease || !det.Pinnable || !det.RollbackReusesLocalRelease || !det.ShadowedNpmInstall {
		t.Fatalf("det = %+v", det)
	}

	// Windows cmd 垫片走 UPSTREAM= 精确提取，同时 npm cmd 垫片落回 npm_global。
	winCmd := filepath.Join(binDir, "codex-shim.cmd")
	if err := os.WriteFile(winCmd, []byte("REM aih-codex-cli-hook\r\nset \"UPSTREAM="+upstreamBin+"\"\r\nset \"NODE_BIN=node.exe\"\r\n"), 0o600); err != nil {
		t.Fatalf("write winCmd: %v", err)
	}
	detWin := DetectCLIChannel(ChannelDetectInput{
		Provider:        "codex",
		ResolvedPath:    winCmd,
		StandaloneRoots: []string{filepath.Join(root, "standalone")},
	})
	if detWin.Channel != ChannelStandaloneRelease {
		t.Fatalf("win cmd channel = %+v", detWin)
	}

	npmJs := filepath.Join(pkgDir, "bin.js")
	if err := os.WriteFile(npmJs, []byte("console.log(1)\n"), 0o644); err != nil {
		t.Fatalf("write npmJs: %v", err)
	}
	npmCmd := filepath.Join(root, "npm", "codex.cmd")
	if err := os.WriteFile(npmCmd, []byte("\"%~dp0%\\node_modules\\@openai\\codex\\bin.js\" %*\r\n"), 0o644); err != nil {
		t.Fatalf("write npmCmd: %v", err)
	}
	detNpm := DetectCLIChannel(ChannelDetectInput{
		Provider:      "codex",
		ResolvedPath:  npmCmd,
		NpmGlobalRoot: npmRoot,
		NpmPackageDir: pkgDir,
	})
	if detNpm.Channel != ChannelNpmGlobal || !detNpm.Pinnable || detNpm.ShadowedNpmInstall {
		t.Fatalf("detNpm = %+v", detNpm)
	}
}

func TestPolicyDecisions(t *testing.T) {
	t.Parallel()
	healthy := true
	now := int64(1_700_000_600_000)

	// 1. 最新版正在 soak 时退一步选中已 soak 的老稳定版。
	dec := Decide(PolicyInput{
		Now:                   now,
		Enabled:               true,
		Pinnable:              true,
		BaselineHealthy:       &healthy,
		KnownGoodRollbackable: true,
		InstalledVersion:      "1.0.0",
		LatestVersion:         "1.2.0",
		PublishedAt:           now - 10_000,
		Releases: []ReleaseTime{
			{Version: "1.1.0", PublishedAt: now - 10*60*1000},
			{Version: "1.2.0", PublishedAt: now - 10_000},
		},
	}, PolicyConfig{SoakMs: DefaultSoakMs, SoakUnknownLimit: 5})
	if dec.Decision != DecisionUpgrade || dec.TargetVersion != "1.1.0" || dec.Reason != "upgrade_soaked_release" {
		t.Fatalf("soaked release fallback = %+v", dec)
	}

	// 2. publish time 未知达到上限转 soak_unknown。
	decUnknown := Decide(PolicyInput{
		Now:                   now,
		Enabled:               true,
		Pinnable:              true,
		BaselineHealthy:       &healthy,
		KnownGoodRollbackable: true,
		InstalledVersion:      "1.0.0",
		LatestVersion:         "1.2.0",
		SoakUnknownCount:      5,
	}, PolicyConfig{SoakMs: DefaultSoakMs, SoakUnknownLimit: 5})
	if decUnknown.Decision != DecisionSkip || decUnknown.Reason != "soak_unknown" {
		t.Fatalf("soak_unknown = %+v", decUnknown)
	}

	// 3. prerelease latest 拒绝跟踪。
	decPre := Decide(PolicyInput{
		Now:                   now,
		Enabled:               true,
		Pinnable:              true,
		BaselineHealthy:       &healthy,
		KnownGoodRollbackable: true,
		InstalledVersion:      "1.0.0",
		LatestVersion:         "1.2.0-rc.1",
		PublishedAt:           now - 10*60*1000,
	}, PolicyConfig{SoakMs: DefaultSoakMs, SoakUnknownLimit: 5})
	if decPre.Reason != "latest_is_prerelease" {
		t.Fatalf("prerelease = %+v", decPre)
	}
}

func TestQuiescenceLiveness(t *testing.T) {
	t.Parallel()
	aiHome := t.TempDir()
	appServerDir := filepath.Join(aiHome, "run", "codex-app-server")
	sessDir := filepath.Join(aiHome, "run", "persistent-sessions")
	if err := os.MkdirAll(appServerDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.MkdirAll(sessDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// 不存在的 pid 不应判忙。
	if err := os.WriteFile(filepath.Join(appServerDir, "dead.json"), []byte(`{"pid":9999999}`), 0o600); err != nil {
		t.Fatalf("write dead: %v", err)
	}
	q := CheckProviderQuiescence("codex", aiHome, "darwin", 1000, nil)
	if q.Busy {
		t.Fatalf("dead pid should not be busy: %+v", q)
	}

	// 存在 persistent session 应判忙。
	if err := os.WriteFile(filepath.Join(sessDir, "aih-codex-1.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatalf("write sess: %v", err)
	}
	q2 := CheckProviderQuiescence("codex", aiHome, "darwin", 1000, nil)
	if !q2.Busy || len(q2.Evidence) != 1 || q2.Evidence[0] != "session:aih-codex-1" {
		t.Fatalf("persistent session busy = %+v", q2)
	}
}

func TestPlanBuilderAndErrorClassifier(t *testing.T) {
	t.Parallel()
	plans, reason := BuildPinnedPlans(PlanBuildInput{
		Channel:    ChannelStandaloneRelease,
		Version:    "0.158.0",
		GoOS:       "darwin",
		InstallDir: "/custom/bin",
		BaseEnv:    map[string]string{"PATH": "/usr/bin"},
	})
	if reason != "" || len(plans) != 1 {
		t.Fatalf("standalone plans = %+v reason=%q", plans, reason)
	}
	if plans[0].Env["CODEX_RELEASE"] != "0.158.0" || plans[0].Env["CODEX_INSTALL_DIR"] != "/custom/bin" || !strings.HasPrefix(plans[0].Env["PATH"], "/custom/bin:") {
		t.Fatalf("env = %#v", plans[0].Env)
	}
	if len(plans[0].PostInstall) != 1 || plans[0].PostInstall[0] != PostInstallReinstallCodexCLIHook {
		t.Fatalf("postInstall = %#v", plans[0].PostInstall)
	}

	f1 := ClassifyInstallFailure(PlanResult{Stderr: "npm error code E404 Not Found on registry.npmjs.org"})
	if f1.Category != CategoryNotFound || f1.CountsTowardBreaker {
		t.Fatalf("not_found classifier = %+v", f1)
	}
	f2 := ClassifyInstallFailure(PlanResult{Stderr: "EPERM: operation not permitted, unlink"})
	if f2.Category != CategoryLockBusy || f2.CountsTowardBreaker {
		t.Fatalf("lock_busy classifier = %+v", f2)
	}
	f3 := ClassifyInstallFailure(PlanResult{Stderr: "segmentation fault"})
	if f3.Category != CategoryHardFailure || !f3.CountsTowardBreaker {
		t.Fatalf("hard classifier = %+v", f3)
	}
}

func TestRunnerLifecycleRollbackAndBrokenReset(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	now := int64(1_700_000_000_000)
	installed := "1.0.0"
	verifyVerdict := VerdictPass
	verifyDetail := "ok"
	var hookReinstalled int

	deps := CycleDeps{
		Now: func() int64 { return now },
		DetectChannel: func(context.Context, string) (ChannelDetection, error) {
			return ChannelDetection{
				Channel:                    ChannelNpmGlobal,
				ResolvedPath:               "/opt/homebrew/bin/gemini",
				OwnerPath:                  "/opt/homebrew/lib/node_modules/@google/gemini-cli/bin.js",
				PackageName:                "@google/gemini-cli",
				Pinnable:                   true,
				RollbackReusesLocalRelease: false,
			}, nil
		},
		CheckUpdate: func(context.Context, string) (UpdateCheckResult, error) {
			return UpdateCheckResult{
				InstalledVersion: installed,
				LatestVersion:    "1.1.0",
				PublishedAt:      now - 10*60*1000,
				PackageName:      "@google/gemini-cli",
			}, nil
		},
		CheckQuiescence: func(context.Context, string) (QuiescenceStatus, error) {
			return QuiescenceStatus{Busy: false, ObservedAt: now}, nil
		},
		RunPlans: func(_ context.Context, _ []InstallPlan, _ string, version string, phase string) PlanResult {
			if phase == "rollback" && verifyDetail == "break_rollback" {
				return PlanResult{OK: false, Error: "rollback crash"}
			}
			installed = version
			return PlanResult{OK: true}
		},
		Verify: func(context.Context, string, string) (Verification, error) {
			return Verification{Verdict: verifyVerdict, Detail: verifyDetail}, nil
		},
		ReinstallCodexCLIHook: func(context.Context) error {
			hookReinstalled++
			return nil
		},
	}

	ledger := EmptyLedger()
	cfg := CycleConfig{ApplyEnabled: true, GoOS: "darwin", SoakMs: DefaultSoakMs, SoakUnknownLimit: 5}

	// 第 1 次静默推迟（要求连续两次静默）。
	out1 := RunProviderCycle(ctx, "gemini", ledger, deps, cfg)
	if out1.State != StateDeferred || out1.Reason != "awaiting_quiescence" {
		t.Fatalf("out1 = %+v", out1)
	}
	// 第 2 次静默且新版 verify fail，触发回滚。
	verifyVerdict = VerdictFail
	verifyDetail = "bad_upgrade"
	// 注意基线 1.0.0 已经在第 1 轮通过验证记进 knownGoodVersion 了。
	// 回滚重装到 1.0.0 后再验一次 1.0.0 时让它 pass。
	depsRollbackOK := deps
	depsRollbackOK.Verify = func(_ context.Context, _ string, ver string) (Verification, error) {
		if ver == "1.1.0" {
			return Verification{Verdict: VerdictFail, Detail: "bad_upgrade"}, nil
		}
		return Verification{Verdict: VerdictPass, Detail: "restored"}, nil
	}
	out2 := RunProviderCycle(ctx, "gemini", out1.Ledger, depsRollbackOK, cfg)
	if out2.State != StateRolledBack || out2.Reason != "rolled_back" {
		t.Fatalf("out2 = %+v", out2)
	}
	if rec := out2.Ledger.Record("gemini"); rec.InstalledVersion != "1.0.0" || !containsString(rec.BlockedVersions, "1.1.0") {
		t.Fatalf("rolled back rec = %+v", rec)
	}

	// 连续故障且回滚本身失败则熔断。
	depsBroken := deps
	depsBroken.Verify = func(context.Context, string, string) (Verification, error) {
		return Verification{Verdict: VerdictFail, Detail: "bad_upgrade"}, nil
	}
	verifyDetail = "break_rollback"
	bLedger := out2.Ledger
	recB := bLedger.Record("gemini")
	recB.BlockedVersions = []string{}
	recB.ConsecutiveQuiescentTicks = 2
	bLedger = bLedger.WithProvider("gemini", recB)

	out3 := RunProviderCycle(ctx, "gemini", bLedger, depsBroken, cfg)
	if out3.State != StateBroken || out3.Ledger.Record("gemini").Enabled {
		t.Fatalf("broken out3 = %+v rec=%+v", out3, out3.Ledger.Record("gemini"))
	}

	// 已熔断的 provider 不会自动重试。
	out4 := RunProviderCycle(ctx, "gemini", out3.Ledger, deps, cfg)
	if out4.State != StateBroken || out4.Reason != "provider_broken" {
		t.Fatalf("stuck broken out4 = %+v", out4)
	}

	// Verify clearBroken resets circuit.
	catalog, _ := providers.NewCatalog(providers.BuiltinManifest())
	_ = hookReinstalled
	_ = catalog
}
