package providercliupgrade

import (
	"context"
	"errors"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/runtime/codexhooks"
)

// ListUpgradeCandidateProviders 返回声明了 npm CLI 包的候选 provider 列表（有包名才能钉版本升级/回滚）。
func ListUpgradeCandidateProviders(catalog *providers.Catalog) []string {
	if catalog == nil {
		return []string{}
	}
	defs := catalog.List()
	out := make([]string, 0, len(defs))
	seen := make(map[string]struct{}, len(defs))
	for _, def := range defs {
		if def.CLI == nil || strings.TrimSpace(def.CLI.Package) == "" {
			continue
		}
		if _, exists := seen[def.ID]; exists {
			continue
		}
		seen[def.ID] = struct{}{}
		out = append(out, def.ID)
	}
	return out
}

// ProviderPackageName 返回 provider 在 catalog 中声明的 CLI npm 包名。
func ProviderPackageName(catalog *providers.Catalog, provider string) string {
	if catalog == nil {
		return ""
	}
	def, ok := catalog.Get(strings.TrimSpace(provider))
	if !ok || def.CLI == nil {
		return ""
	}
	return strings.TrimSpace(def.CLI.Package)
}

// ProviderBinaryName 返回 provider 在 catalog 中声明的可执行文件名，缺省退回 provider id。
func ProviderBinaryName(catalog *providers.Catalog, provider string) string {
	if catalog == nil {
		return provider
	}
	def, ok := catalog.Get(strings.TrimSpace(provider))
	if !ok || def.CLI == nil || strings.TrimSpace(def.CLI.BinaryName) == "" {
		return provider
	}
	return strings.TrimSpace(def.CLI.BinaryName)
}

// RealDepsOptions 配置生产级升级依赖。
type RealDepsOptions struct {
	AIHomeDir             string
	HostHomeDir           string
	Catalog               *providers.Catalog
	GoOS                  string
	BaseEnv               map[string]string
	NodeExecutable        string
	PowerShellExecutable  string
	HelperScriptPath      string
	OverrideNpmGlobalRoot string
	VersionProbeTimeout   time.Duration
	CodexVerifyTimeout    time.Duration
	ReleaseCache          *ReleaseTimeCache
	ResolveCommand        func(binaryName string) string
	ReinstallCodexCLIHook func(ctx context.Context) error
	Log                   func(entry map[string]any)
}

// RealDeps 将升级状态机接到真实文件系统、PATH、npm 与 codex 沙箱强判据上。
type RealDeps struct {
	aiHomeDir      string
	hostHomeDir    string
	catalog        *providers.Catalog
	goos           string
	baseEnv        map[string]string
	nodeExec       string
	psExec         string
	overrideNpm    string
	probeTimeout   time.Duration
	verifyTimeout  time.Duration
	releaseCache   *ReleaseTimeCache
	resolveCommand func(binaryName string) string
	reinstallHook  func(ctx context.Context) error
	logFn          func(entry map[string]any)

	rootsMu     sync.Mutex
	cachedRoots *InstallRoots

	memoMu      sync.Mutex
	channelMemo map[string]string
}

// NewRealDeps 创建生产级 CLI 升级依赖，并按需接入 codex CLI hook 自愈重装。
func NewRealDeps(opts RealDepsOptions) *RealDeps {
	goos := strings.TrimSpace(opts.GoOS)
	if goos == "" {
		goos = runtime.GOOS
	}
	cache := opts.ReleaseCache
	if cache == nil {
		cache = NewReleaseTimeCache(DefaultReleaseCacheMaxAge, time.Now)
	}
	d := &RealDeps{
		aiHomeDir:      strings.TrimSpace(opts.AIHomeDir),
		hostHomeDir:    strings.TrimSpace(opts.HostHomeDir),
		catalog:        opts.Catalog,
		goos:           goos,
		baseEnv:        opts.BaseEnv,
		nodeExec:       strings.TrimSpace(opts.NodeExecutable),
		psExec:         strings.TrimSpace(opts.PowerShellExecutable),
		overrideNpm:    strings.TrimSpace(opts.OverrideNpmGlobalRoot),
		probeTimeout:   opts.VersionProbeTimeout,
		verifyTimeout:  opts.CodexVerifyTimeout,
		releaseCache:   cache,
		resolveCommand: opts.ResolveCommand,
		reinstallHook:  opts.ReinstallCodexCLIHook,
		logFn:          opts.Log,
		channelMemo:    make(map[string]string),
	}
	if d.reinstallHook == nil && d.aiHomeDir != "" {
		svc := codexhooks.NewCLIHookService(codexhooks.CLIHookOptions{
			AIHomeDir:        d.aiHomeDir,
			HostHomeDir:      d.hostHomeDir,
			Platform:         goos,
			NodeExecPath:     d.nodeExec,
			HelperScriptPath: strings.TrimSpace(opts.HelperScriptPath),
		})
		if svc.ReadState().Enabled {
			d.reinstallHook = func(_ context.Context) error {
				res := svc.EnsureInstalled(codexhooks.CLIHookEnsureOptions{Background: false})
				if !res.OK {
					msg := strings.TrimSpace(res.Reason)
					if msg == "" {
						msg = "hook_reinstall_failed"
					}
					return errors.New(msg)
				}
				return nil
			}
		}
	}
	return d
}

// CycleDeps 返回供 RunProviderCycle 使用的依赖集合。
func (d *RealDeps) CycleDeps() CycleDeps {
	return CycleDeps{
		Now:                   func() int64 { return time.Now().UnixMilli() },
		DetectChannel:         d.DetectChannel,
		CheckUpdate:           d.CheckUpdate,
		CheckQuiescence:       d.CheckQuiescence,
		RunPlans:              d.RunPlans,
		Verify:                d.Verify,
		ReinstallCodexCLIHook: d.reinstallHook,
		Log:                   d.logFn,
	}
}

// ProbeInstalledVersion 实现 ClearBrokenVerifier：探测当前会被启动的 CLI 版本。
func (d *RealDeps) ProbeInstalledVersion(ctx context.Context, provider string) (string, error) {
	resolved := d.resolveCLIPath(provider)
	if resolved == "" {
		return "", nil
	}
	return d.probeVersion(ctx, resolved), nil
}

// Verify 实现 ClearBrokenVerifier 与 CycleDeps.Verify：同一性断言 + 渠道漂移断言 + codex 强判据。
func (d *RealDeps) Verify(ctx context.Context, provider string, expectedVersion string) (Verification, error) {
	p := strings.ToLower(strings.TrimSpace(provider))
	identityDeps := IdentityVerifierDeps{
		ResolveCLIPath: func(target string) (string, error) {
			return d.resolveCLIPath(target), nil
		},
		ProbeVersion: func(probeCtx context.Context, cliPath string) (string, error) {
			return d.probeVersion(probeCtx, cliPath), nil
		},
		Realpath: safeRealpath,
	}

	strong := func(verifyCtx context.Context, targetProvider string, _ string) (Verification, error) {
		d.memoMu.Lock()
		expectedChannel := d.channelMemo[targetProvider]
		d.memoMu.Unlock()
		if expectedChannel != "" {
			actualChannel := d.inspectChannel(verifyCtx, targetProvider).Channel
			if actualChannel != expectedChannel {
				return Verification{
					Verdict: VerdictFail,
					Detail:  "channel_drift:" + actualChannel + "!=" + expectedChannel,
				}, nil
			}
		}
		if targetProvider != "codex" {
			return Verification{Verdict: VerdictPass, Detail: "channel_stable"}, nil
		}
		cliPath := d.resolveCLIPath(targetProvider)
		return VerifyCodexAppServerBoot(verifyCtx, CodexVerifyOptions{
			CLIPath:        cliPath,
			Timeout:        d.verifyTimeout,
			GoOS:           d.goos,
			NodeExecutable: d.nodeExec,
			BaseEnv:        d.baseEnv,
		}), nil
	}

	return CompositeVerify(ctx, p, expectedVersion, identityDeps, strong), nil
}

func (d *RealDeps) DetectChannel(ctx context.Context, provider string) (ChannelDetection, error) {
	detected := d.inspectChannel(ctx, provider)
	d.memoMu.Lock()
	d.channelMemo[provider] = detected.Channel
	d.memoMu.Unlock()
	return detected, nil
}

func (d *RealDeps) CheckUpdate(ctx context.Context, provider string) (UpdateCheckResult, error) {
	pkg := ProviderPackageName(d.catalog, provider)
	resolved := d.resolveCLIPath(provider)
	installedVersion := d.probeVersion(ctx, resolved)
	if pkg == "" {
		return UpdateCheckResult{InstalledVersion: installedVersion}, nil
	}

	env := envSliceFromMap(d.baseEnv)
	latestVersion, err := QueryNpmLatestVersion(ctx, pkg, d.goos, env)
	if err != nil {
		return UpdateCheckResult{}, err
	}

	if releases, publishedAt, hit := d.releaseCache.Get(pkg, latestVersion); hit {
		return UpdateCheckResult{
			InstalledVersion: installedVersion,
			LatestVersion:    latestVersion,
			PublishedAt:      publishedAt,
			PackageName:      pkg,
			Releases:         releases,
		}, nil
	}

	var publishedAt int64
	var releases []ReleaseTime
	releasesListed := false
	table, stable, err := FetchNpmTimeTable(ctx, pkg, d.goos, env)
	if err == nil {
		releases = stable
		releasesListed = true
		if ts, ok := table[latestVersion]; ok {
			publishedAt = ts
		}
	}
	if latestVersion != "" && publishedAt == 0 {
		detail := "publish_time_missing"
		if err != nil {
			detail = err.Error()
		}
		if d.logFn != nil {
			d.logFn(map[string]any{
				"provider": provider,
				"at":       time.Now().UnixMilli(),
				"event":    "publish_time_unavailable",
				"version":  latestVersion,
				"detail":   detail,
			})
		}
	}

	if releasesListed && publishedAt > 0 {
		d.releaseCache.Set(pkg, latestVersion, releases, publishedAt)
	}
	return UpdateCheckResult{
		InstalledVersion: installedVersion,
		LatestVersion:    latestVersion,
		PublishedAt:      publishedAt,
		PackageName:      pkg,
		Releases:         releases,
	}, nil
}

func (d *RealDeps) CheckQuiescence(_ context.Context, provider string) (QuiescenceStatus, error) {
	return CheckProviderQuiescence(provider, d.aiHomeDir, d.goos, time.Now().UnixMilli(), nil), nil
}

func (d *RealDeps) RunPlans(ctx context.Context, plans []InstallPlan, _ string, _ string, _ string) PlanResult {
	return ExecuteInstallPlans(ctx, plans, d.goos, d.baseEnv)
}

func (d *RealDeps) inspectChannel(ctx context.Context, provider string) ChannelDetection {
	resolvedPath := d.resolveCLIPath(provider)
	roots := d.getRoots(ctx)
	pkg := ProviderPackageName(d.catalog, provider)
	detected := DetectCLIChannel(ChannelDetectInput{
		Provider:              provider,
		ResolvedPath:          resolvedPath,
		StandaloneRoots:       roots.StandaloneRoots,
		NpmGlobalRoot:         roots.NpmGlobalRoot,
		VendorSelfUpdateRoots: roots.VendorSelfUpdateRoots,
		HomebrewRoots:         roots.HomebrewRoots,
		NpmPackageDir:         NpmPackageDirFor(roots.NpmGlobalRoot, pkg),
	})
	detected.PackageName = pkg
	if resolvedPath != "" {
		detected.InstallDir = filepath.Dir(resolvedPath)
	}
	return detected
}

func (d *RealDeps) getRoots(ctx context.Context) InstallRoots {
	d.rootsMu.Lock()
	defer d.rootsMu.Unlock()
	if d.cachedRoots == nil {
		roots := ResolveInstallRoots(ctx, d.hostHomeDir, d.baseEnv, d.goos, d.overrideNpm, d.nodeExec)
		d.cachedRoots = &roots
	}
	return *d.cachedRoots
}

func (d *RealDeps) resolveCLIPath(provider string) string {
	binName := ProviderBinaryName(d.catalog, provider)
	if d.resolveCommand != nil {
		return strings.TrimSpace(d.resolveCommand(binName))
	}
	extraPath := ""
	if d.baseEnv != nil {
		extraPath = d.baseEnv["PATH"]
	}
	return ResolveCommandPath(binName, d.hostHomeDir, d.goos, extraPath)
}

func (d *RealDeps) probeVersion(ctx context.Context, cliPath string) string {
	return ProbeVersion(ctx, cliPath, ProbeOptions{
		GoOS:                 d.goos,
		NodeExecutable:       d.nodeExec,
		PowerShellExecutable: d.psExec,
		Timeout:              d.probeTimeout,
		Env:                  envSliceFromMap(d.baseEnv),
	})
}
