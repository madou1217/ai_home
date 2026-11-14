package webuiopenappapi

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/modelalias"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/hostapps"
	"github.com/madou1217/ai_home/internal/adapters/kimi/desktopsession"
	"github.com/madou1217/ai_home/internal/runtime/codexhooks"
	runtimeegress "github.com/madou1217/ai_home/internal/runtime/egress"
)

// AccountSnapshot 汇总打开/关闭应用所需的账号身份、资格、公开资料与凭据快照。
type AccountSnapshot struct {
	AccountRef            accountcore.AccountRef
	Provider              string
	CLIAccountID          int64
	Enabled               bool
	Configured            bool
	AuthInvalid           bool
	APIKeyMode            bool
	AuthMode              string
	BaseURL               string
	DisplayName           string
	Email                 string
	CredentialUpdatedAtMS int64
	Credential            accountapp.Credential
	NativeAuthJSON        json.RawMessage
}

// AccountLookup 读取账号资格、凭据与写回更新后的原生凭据。
type AccountLookup interface {
	LookupAccount(ctx context.Context, provider string, accountRef string) (AccountSnapshot, bool, error)
	UpdateNativeCredential(ctx context.Context, accountRef string, payload []byte, now time.Time) error
}

// EgressResolution 描述一次应用启动的出口解析结果。
type EgressResolution struct {
	OK          bool
	Bound       bool
	Source      string
	ProxyServer string
	Direct      bool
	Error       string
	Reason      string
	Message     string
	Warning     string
}

// AccountEgressPort 抽象账号出口解析与启动期网络守卫，便于单测隔离真实网络/SQLite。
type AccountEgressPort interface {
	Resolve(ctx context.Context, provider, accountRef, platform string) EgressResolution
	CheckLaunchNetwork(ctx context.Context, aiHomeDir, provider, accountRef string, env []string, res EgressResolution) (denied bool, reason string)
}

// ModelAliasPort 抽象模型别名查询，用于跨 Provider CLI 校验所选别名是否可路由到当前身份供应商。
type ModelAliasPort interface {
	ListAliases(ctx context.Context) ([]modelalias.Record, error)
}

// CodexHookPort 抽象 Codex Desktop Hook 安装、钉选账号切换与后台重启控制。
type CodexHookPort interface {
	EnsureInstalled() (codexhooks.DesktopHookResult, error)
	SetDesktopAccountRef(accountRef string) codexhooks.AccountRefMutationResult
	ClearDesktopAccountRef(expectedRef string) codexhooks.AccountRefMutationResult
	RestartRunningAppServers() codexhooks.RestartAppServersResult
}

// ProcessScannerPort 抽象宿主机 Desktop / CLI 进程探测。
type ProcessScannerPort interface {
	ListDesktopInstances(ctx context.Context) ([]hostapps.DesktopInstance, error)
	ListCLIInstances(ctx context.Context) ([]hostapps.CLIInstance, error)
}

// RunOptions 控制一次同步宿主机命令执行。
type RunOptions struct {
	Dir     string
	Env     []string
	Timeout time.Duration
}

// RunOutput 记录同步命令的退出状态与输出。
type RunOutput struct {
	ExitCode int
	Stdout   string
	Stderr   string
	Err      error
}

// SpawnSpec 描述一次需要脱离当前服务后台运行的子进程参数。
type SpawnSpec struct {
	File        string
	Args        []string
	Dir         string
	Env         []string
	WindowsHide bool
}

// CommandRunner 抽象同步命令执行、后台脱离拉起及进程树信号关闭。
type CommandRunner interface {
	Run(ctx context.Context, name string, args []string, opts RunOptions) RunOutput
	StartDetached(spec SpawnSpec) (int, error)
	IsProcessAlive(pid int) bool
	CloseProcessTree(ctx context.Context, pids []int, grace time.Duration, sleep func(context.Context, time.Duration) error) ([]int, error)
}

// WebUITerminalOpenRequest 表示把账号 CLI 打开到 WebUI 内置终端 PTY 会话的入参。
type WebUITerminalOpenRequest struct {
	SessionKey string
	Cwd        string
	File       string
	Args       []string
	Env        []string
	Persistent bool
}

// WebUITerminalOpenResult 表示 WebUI 终端会话拉起或复用结果。
type WebUITerminalOpenResult struct {
	TermID     string
	SessionKey string
	Reused     bool
}

// WebUITerminalOpener 抽象 WebUI 持久 PTY 打开能力。
type WebUITerminalOpener func(ctx context.Context, req WebUITerminalOpenRequest) (WebUITerminalOpenResult, error)

// InstallAvailableChecker 查询指定目标是否存在可用的自动化安装器。
type InstallAvailableChecker func(provider, kind, appID string) bool

// KimiSessionPort 抽象 Kimi Desktop 托管登录会话读取。
type KimiSessionPort interface {
	ReadSession(ctx context.Context, accountRef string) (desktopsession.Session, bool, error)
	WriteSession(ctx context.Context, accountRef string, session desktopsession.Session) error
}

// DesktopAppRecord 表示探测到的本地 Desktop 客户端安装位置。
type DesktopAppRecord struct {
	Provider       string
	ClientName     string
	BundlePath     string
	ExecutablePath string
	DisplayPath    string
	Version        string
}

// DesktopAppFinder 根据 Provider 与宿主目录查找已安装的 Desktop 应用。
type DesktopAppFinder func(ctx context.Context, provider, hostHomeDir string) *DesktopAppRecord

// CLIBinaryFinder 根据 harness/binaryName 与宿主目录查找本地 CLI 可执行文件。
type CLIBinaryFinder func(ctx context.Context, harness, binaryName, hostHomeDir string) string

// NativeLauncherDependencies 汇总 NativeLauncher 所需的生产/测试依赖。
type NativeLauncherDependencies struct {
	AIHomeDir           string
	HostHomeDir         string
	RepoRoot            string
	Platform            string
	Catalog             *providers.Catalog
	Store               *sqliteaccount.Store
	Accounts            AccountLookup
	EgressManager       *runtimeegress.Manager
	Egress              AccountEgressPort
	ModelAliases        ModelAliasPort
	CodexHooksService   *codexhooks.DesktopHookService
	CodexHooks          CodexHookPort
	ProcessScanner      ProcessScannerPort
	Runner              CommandRunner
	WebUITerminalOpener WebUITerminalOpener
	InstallChecker      InstallAvailableChecker
	KimiSessions        KimiSessionPort
	DesktopAppFinder    DesktopAppFinder
	CLIBinaryFinder     CLIBinaryFinder
	Now                 func() time.Time
	Sleep               func(context.Context, time.Duration) error
	Environ             func() []string
	Warn                func(string)
}

type sqliteAccountAdapter struct {
	store *sqliteaccount.Store
}

func (a *sqliteAccountAdapter) LookupAccount(ctx context.Context, provider, accountRef string) (AccountSnapshot, bool, error) {
	if a == nil || a.store == nil {
		return AccountSnapshot{}, false, errors.New("account_store_unavailable")
	}
	parsedRef, err := accountcore.ParseAccountRef(accountRef)
	if err != nil {
		return AccountSnapshot{}, false, nil
	}
	account, err := a.store.GetByRef(ctx, parsedRef)
	if err != nil {
		if errors.Is(err, accountapp.ErrAccountNotFound) {
			return AccountSnapshot{}, false, nil
		}
		return AccountSnapshot{}, false, err
	}
	normalizedProvider := strings.ToLower(strings.TrimSpace(provider))
	if normalizedProvider != "" && !strings.EqualFold(account.ProviderID(), normalizedProvider) {
		return AccountSnapshot{}, false, nil
	}

	snapshot := AccountSnapshot{
		AccountRef:   account.Ref(),
		Provider:     strings.ToLower(strings.TrimSpace(account.ProviderID())),
		CLIAccountID: account.CLIAccountID().Int64(),
		Enabled:      account.Enabled(),
	}

	if uiStates, err := a.store.ListAccountUIStates(ctx); err == nil {
		for _, state := range uiStates {
			if state.AccountRef() != parsedRef {
				continue
			}
			snapshot.Configured = state.Configured()
			snapshot.APIKeyMode = state.APIKeyMode()
			snapshot.AuthMode = state.AuthMode()
			snapshot.BaseURL = state.BaseURL()
			snapshot.DisplayName = state.DisplayName()
			if state.OauthPending() {
				snapshot.Configured = false
			}
			break
		}
	}

	if blocks, err := a.store.ListAccountBlocks(ctx); err == nil {
		now := time.Now()
		for _, block := range blocks {
			if block.AccountRef() != parsedRef {
				continue
			}
			if block.Kind() == runtimecore.FailureReauthenticationRequired &&
				(block.Until().IsZero() || block.Until().After(now)) {
				snapshot.AuthInvalid = true
				break
			}
		}
	}

	if credSnap, err := a.store.GetCredentialSnapshot(ctx, parsedRef); err == nil && credSnap.IsValid() {
		snapshot.Credential = credSnap.Credential()
		snapshot.CredentialUpdatedAtMS = credSnap.UpdatedAt().UnixMilli()
		if !snapshot.Configured {
			// 未写入 account_ui_state 时按凭据是否存在回退（AuthInvalid 检查随后仍会扣回）。
			snapshot.Configured = snapshot.Credential != nil
		}
		if native, ok := credSnap.Credential().(*accountcore.NativeCredential); ok && native != nil {
			snapshot.NativeAuthJSON = append(json.RawMessage(nil), native.Payload()...)
		}
	}

	if profileSnap, err := a.store.GetProfile(ctx, parsedRef); err == nil && profileSnap.Profile() != nil {
		if snapshot.DisplayName == "" {
			snapshot.DisplayName = strings.TrimSpace(profileSnap.Profile().DisplayName())
		}
	}
	return snapshot, true, nil
}

func (a *sqliteAccountAdapter) UpdateNativeCredential(ctx context.Context, accountRef string, payload []byte, now time.Time) error {
	if a == nil || a.store == nil {
		return errors.New("account_store_unavailable")
	}
	parsedRef, err := accountcore.ParseAccountRef(accountRef)
	if err != nil {
		return err
	}
	current, err := a.store.GetCredentialSnapshot(ctx, parsedRef)
	if err != nil {
		return err
	}
	existing, ok := current.Credential().(*accountcore.NativeCredential)
	if !ok || existing == nil {
		return errors.New("not_native_credential")
	}
	identity, err := accountcore.NewNativeSubjectIdentity(existing.ProviderID(), existing.IdentitySeed())
	if err != nil {
		return err
	}
	nextCred, err := accountcore.NewNativeCredential(identity, payload, existing.Generations()...)
	if err != nil {
		return err
	}
	updatedAt := now
	if !updatedAt.After(current.UpdatedAt()) {
		updatedAt = current.UpdatedAt().Add(time.Millisecond)
	}
	replacement, err := accountapp.NewCredentialReplacement(current, nextCred, updatedAt)
	if err != nil {
		return err
	}
	return a.store.ReplaceCredential(ctx, replacement)
}

type storeModelAliasAdapter struct {
	store *sqliteaccount.Store
}

func (a *storeModelAliasAdapter) ListAliases(ctx context.Context) ([]modelalias.Record, error) {
	if a == nil || a.store == nil {
		return nil, nil
	}
	records, _, err := a.store.ListModelAliases(ctx)
	return records, err
}

type defaultKimiSessionAdapter struct {
	store *desktopsession.CredentialStore
}

func (a *defaultKimiSessionAdapter) ReadSession(ctx context.Context, accountRef string) (desktopsession.Session, bool, error) {
	if a == nil || a.store == nil {
		return desktopsession.Session{}, false, nil
	}
	return a.store.Read(ctx, accountRef)
}

func (a *defaultKimiSessionAdapter) WriteSession(ctx context.Context, accountRef string, session desktopsession.Session) error {
	if a == nil || a.store == nil {
		return nil
	}
	return a.store.Write(ctx, accountRef, session)
}

type defaultCommandRunner struct{}

func (defaultCommandRunner) Run(ctx context.Context, name string, args []string, opts RunOptions) RunOutput {
	runCtx := ctx
	var cancel context.CancelFunc
	if opts.Timeout > 0 {
		runCtx, cancel = context.WithTimeout(ctx, opts.Timeout)
		defer cancel()
	}
	cmd := exec.CommandContext(runCtx, name, args...)
	if opts.Dir != "" {
		cmd.Dir = opts.Dir
	}
	if len(opts.Env) > 0 {
		cmd.Env = opts.Env
	}
	var stdoutBuf, stderrBuf strings.Builder
	cmd.Stdout = &stdoutBuf
	cmd.Stderr = &stderrBuf
	err := cmd.Run()
	exitCode := 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = -1
		}
	}
	return RunOutput{
		ExitCode: exitCode,
		Stdout:   stdoutBuf.String(),
		Stderr:   stderrBuf.String(),
		Err:      err,
	}
}

func (r defaultCommandRunner) StartDetached(spec SpawnSpec) (int, error) {
	return startDetachedOS(spec)
}

func (defaultCommandRunner) IsProcessAlive(pid int) bool {
	return isProcessAliveOS(pid)
}

func (r defaultCommandRunner) CloseProcessTree(
	ctx context.Context,
	pids []int,
	grace time.Duration,
	sleep func(context.Context, time.Duration) error,
) ([]int, error) {
	return closeProcessTreeOS(ctx, r, pids, grace, sleep)
}

func desktopEnvRulesFromCatalog(catalog *providers.Catalog) []hostapps.EnvRule {
	if catalog == nil {
		return nil
	}
	rules := make([]hostapps.EnvRule, 0, 4)
	for _, definition := range catalog.List() {
		if definition.CLI == nil || definition.CLI.DesktopClient == nil {
			continue
		}
		client := definition.CLI.DesktopClient
		envKey := strings.TrimSpace(client.UserDataEnvKey)
		if envKey == "" || client.MacOS == nil || len(client.MacOS.PathIncludes) == 0 {
			continue
		}
		rules = append(rules, hostapps.EnvRule{
			EnvKey:       envKey,
			PathIncludes: append([]string(nil), client.MacOS.PathIncludes...),
		})
	}
	return rules
}

func normalizePlatformKey(raw string) string {
	val := strings.ToLower(strings.TrimSpace(raw))
	if val == "" {
		val = runtime.GOOS
	}
	switch val {
	case "macos", "darwin":
		return "darwin"
	case "win32", "windows":
		return "windows"
	case "linux":
		return "linux"
	default:
		return val
	}
}

func defaultSleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// resolveAppHomeDir 在宿主环境被账号投影改写时回退读取真实用户家目录（Desktop 应用装在真实 ~/Applications）。
func resolveAppHomeDir(candidate string) string {
	trimmed := strings.TrimSpace(candidate)
	if trimmed != "" {
		slashed := filepath.ToSlash(trimmed)
		if !strings.Contains(slashed, "/run/login/") && !strings.Contains(slashed, "/run/auth-projections/") {
			return trimmed
		}
	}
	if realHome := lookupOSUserHomeDir(); realHome != "" {
		return realHome
	}
	if home, err := os.UserHomeDir(); err == nil && strings.TrimSpace(home) != "" {
		return strings.TrimSpace(home)
	}
	return trimmed
}

func parsePositivePIDs(raw []int) []int {
	seen := make(map[int]struct{}, len(raw))
	out := make([]int, 0, len(raw))
	for _, pid := range raw {
		if pid <= 0 {
			continue
		}
		if _, dup := seen[pid]; dup {
			continue
		}
		seen[pid] = struct{}{}
		out = append(out, pid)
	}
	return out
}

func formatCLIID(id int64) string {
	if id <= 0 {
		return ""
	}
	return strconv.FormatInt(id, 10)
}
