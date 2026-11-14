package webuiopenappapi

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/madou1217/ai_home/internal/adapters/hostapps"
	"github.com/madou1217/ai_home/internal/adapters/kimi/desktopsession"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/apps"
)

type inflightDesktopOpen struct {
	done chan struct{}
	res  Result
	err  error
}

type accountOperationLane struct {
	mu       sync.Mutex
	inflight *inflightDesktopOpen
}

// NativeLauncher 是 webuiopenappapi.Launcher 的纯 Go 原生实现：
// 直接完成账号资格判定、出口解析与守卫、Desktop/CLI 进程生命周期及沙箱投影准备，
// 不再回环调用 Node /v0/internal/accounts/launch-app。
type NativeLauncher struct {
	deps  NativeLauncherDependencies
	mu    sync.Mutex
	lanes map[string]*accountOperationLane
}

// NewNativeLauncher 构建原生 Go 启动器，并为未显式注入的端口补充生产默认适配器。
func NewNativeLauncher(deps NativeLauncherDependencies) *NativeLauncher {
	deps.AIHomeDir = strings.TrimSpace(deps.AIHomeDir)
	deps.HostHomeDir = resolveAppHomeDir(deps.HostHomeDir)
	deps.Platform = normalizePlatformKey(deps.Platform)
	if strings.TrimSpace(deps.RepoRoot) == "" {
		deps.RepoRoot = discoverRepositoryRoot()
	}

	if deps.Accounts == nil && deps.Store != nil {
		deps.Accounts = &sqliteAccountAdapter{store: deps.Store}
	}
	if deps.Egress == nil && deps.EgressManager != nil {
		deps.Egress = newEgressManagerAdapter(deps.EgressManager, deps.AIHomeDir)
	}
	if deps.ModelAliases == nil && deps.Store != nil {
		deps.ModelAliases = &storeModelAliasAdapter{store: deps.Store}
	}
	if deps.CodexHooks == nil && deps.CodexHooksService != nil {
		deps.CodexHooks = deps.CodexHooksService
	}
	if deps.Runner == nil {
		deps.Runner = defaultCommandRunner{}
	}
	if deps.ProcessScanner == nil {
		scanner := hostapps.NewScanner(hostappsPlatform(deps.Platform))
		scanner.EnvRules = desktopEnvRulesFromCatalog(deps.Catalog)
		deps.ProcessScanner = scanner
	}
	if deps.KimiSessions == nil && deps.Store != nil {
		if ks, err := desktopsession.NewCredentialStore(deps.Store, deps.Now); err == nil {
			deps.KimiSessions = &defaultKimiSessionAdapter{store: ks}
		}
	}
	if deps.DesktopAppFinder == nil {
		catalog := deps.Catalog
		platformKey := deps.Platform
		deps.DesktopAppFinder = func(ctx context.Context, provider, hostHomeDir string) *DesktopAppRecord {
			rec := apps.FindDesktopClientRecord(ctx, provider, apps.Options{
				Catalog:     catalog,
				HostHomeDir: hostHomeDir,
				Platform:    catalogPlatformKey(platformKey),
			})
			if rec == nil {
				return nil
			}
			return &DesktopAppRecord{
				Provider:       rec.Provider,
				ClientName:     rec.ClientName,
				BundlePath:     rec.BundlePath,
				ExecutablePath: rec.ExecutablePath,
				DisplayPath:    rec.DisplayPath,
				Version:        rec.Version,
			}
		}
	}
	if deps.CLIBinaryFinder == nil {
		catalog := deps.Catalog
		platformKey := deps.Platform
		environFn := deps.currentEnviron
		deps.CLIBinaryFinder = func(_ context.Context, harness, binaryName, hostHomeDir string) string {
			envMap := envSliceToStringMap(environFn())
			if found := strings.TrimSpace(apps.ResolveProviderCLIPath(harness, apps.Options{
				Catalog:     catalog,
				HostHomeDir: hostHomeDir,
				Platform:    catalogPlatformKey(platformKey),
				Env:         envMap,
			})); found != "" {
				return found
			}
			name := strings.TrimSpace(binaryName)
			if name == "" {
				name = strings.TrimSpace(harness)
			}
			if name == "" {
				return ""
			}
			for _, dir := range hostSearchDirectories(environFn(), platformKey) {
				candidate := filepath.Join(dir, name)
				if isExecutableFile(candidate, catalogPlatformKey(platformKey)) {
					return candidate
				}
				if platformKey == "windows" && !strings.HasSuffix(strings.ToLower(name), ".exe") {
					if exe := candidate + ".exe"; isExecutableFile(exe, "windows") {
						return exe
					}
				}
			}
			if looked, err := exec.LookPath(name); err == nil {
				return looked
			}
			return ""
		}
	}
	if deps.InstallChecker == nil {
		catalog := deps.Catalog
		aiHome := deps.AIHomeDir
		hostHome := deps.HostHomeDir
		platformKey := deps.Platform
		jobManager := apps.NewJobManager(nil, apps.Options{
			Catalog:     catalog,
			AIHomeDir:   aiHome,
			HostHomeDir: hostHome,
			Platform:    catalogPlatformKey(platformKey),
		})
		deps.InstallChecker = func(provider, kind, appID string) bool {
			return jobManager.CanInstall(apps.InstallInput{
				AppID:    appID,
				Provider: provider,
				Kind:     kind,
				Action:   "install",
			})
		}
	}

	return &NativeLauncher{
		deps:  deps,
		lanes: make(map[string]*accountOperationLane),
	}
}

// Launch 执行一次应用打开或关闭请求。对 Desktop 同账号的并发 open 做单飞合并，
// open 与 close 在同账号维度串行执行，避免双启或竞态回滚。
func (l *NativeLauncher) Launch(ctx context.Context, req Request) (Result, error) {
	if l == nil {
		return Result{OK: false, Error: "launch_failed", Message: "launcher unavailable"}, nil
	}
	req.Provider = strings.ToLower(strings.TrimSpace(req.Provider))
	req.AccountRef = strings.TrimSpace(req.AccountRef)
	req.Kind = strings.ToLower(strings.TrimSpace(req.Kind))
	req.Action = strings.ToLower(strings.TrimSpace(req.Action))
	if req.Action == "" {
		req.Action = "open"
	}
	if strings.TrimSpace(req.Harness) == "" {
		req.Harness = req.Provider
	} else {
		req.Harness = strings.ToLower(strings.TrimSpace(req.Harness))
	}

	if req.Kind == "desktop" && req.AccountRef != "" && (req.Action == "open" || req.Action == "close") {
		return l.enqueueDesktopAccountOp(req.Provider, req.AccountRef, req.Action, func() (Result, error) {
			return l.execute(ctx, req)
		})
	}
	return l.execute(ctx, req)
}

func (l *NativeLauncher) execute(ctx context.Context, req Request) (Result, error) {
	var snapshot AccountSnapshot
	var hasAccount bool
	if req.AccountRef != "" {
		if l.deps.Accounts == nil {
			return Result{OK: false, Error: "account_not_found", Message: launchErrorMessage("account_not_found")}, nil
		}
		acc, found, err := l.deps.Accounts.LookupAccount(ctx, req.Provider, req.AccountRef)
		if err != nil {
			return Result{}, err
		}
		if !found {
			return Result{
				OK:      false,
				Error:   "account_not_found",
				Message: launchErrorMessage("account_not_found"),
			}, nil
		}
		snapshot = acc
		hasAccount = true
	}

	if hasAccount && req.Action == "open" {
		if failRes := evaluateAccountEligibility(snapshot, l.deps.nowTime()); failRes != nil {
			return *failRes, nil
		}
	}

	if req.Kind == "cli" {
		return l.executeCLI(ctx, req, snapshot, hasAccount)
	}
	if req.Kind == "desktop" {
		return l.executeDesktop(ctx, req, snapshot)
	}
	return Result{
		OK:      false,
		Error:   "unsupported_kind",
		Message: launchErrorMessage("unsupported_kind"),
	}, nil
}

func (l *NativeLauncher) enqueueDesktopAccountOp(
	provider string,
	accountRef string,
	action string,
	fn func() (Result, error),
) (Result, error) {
	key := provider + ":" + accountRef
	l.mu.Lock()
	lane, exists := l.lanes[key]
	if !exists {
		lane = &accountOperationLane{}
		l.lanes[key] = lane
	}
	if action == "open" && lane.inflight != nil {
		inflight := lane.inflight
		l.mu.Unlock()
		<-inflight.done
		return inflight.res, inflight.err
	}
	var openRun *inflightDesktopOpen
	if action == "open" {
		openRun = &inflightDesktopOpen{done: make(chan struct{})}
		lane.inflight = openRun
	}
	l.mu.Unlock()

	lane.mu.Lock()
	res, err := fn()
	lane.mu.Unlock()

	if openRun != nil {
		l.mu.Lock()
		if lane.inflight == openRun {
			lane.inflight = nil
		}
		l.mu.Unlock()
		openRun.res = res
		openRun.err = err
		close(openRun.done)
	}
	return res, err
}

func hostappsPlatform(platformKey string) string {
	switch normalizePlatformKey(platformKey) {
	case "darwin":
		return "darwin"
	case "windows":
		return "windows"
	default:
		if runtime.GOOS == "darwin" || runtime.GOOS == "windows" {
			return runtime.GOOS
		}
		return "linux"
	}
}

func discoverRepositoryRoot() string {
	searchFrom := func(start string) string {
		cur := filepath.Clean(start)
		for i := 0; i < 8; i++ {
			if cur == "" || cur == "." || cur == filepath.Dir(cur) {
				break
			}
			if info, err := os.Stat(filepath.Join(cur, "bin", "ai-home.js")); err == nil && !info.IsDir() {
				return cur
			}
			cur = filepath.Dir(cur)
		}
		return ""
	}
	if exe, err := os.Executable(); err == nil && exe != "" {
		if root := searchFrom(filepath.Dir(exe)); root != "" {
			return root
		}
	}
	if cwd, err := os.Getwd(); err == nil && cwd != "" {
		if root := searchFrom(cwd); root != "" {
			return root
		}
	}
	return ""
}
