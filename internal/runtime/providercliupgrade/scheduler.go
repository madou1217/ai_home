package providercliupgrade

import (
	"context"
	"errors"
	"fmt"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/core/providers"
)

const (
	// DefaultUpgradeStartDelayMs 是调度器启动后首轮延迟（5 分钟）。
	DefaultUpgradeStartDelayMs int64 = 5 * 60 * 1000
	// DefaultUpgradeIntervalMs 是常规轮询间隔（5 分钟）。
	DefaultUpgradeIntervalMs int64 = 5 * 60 * 1000
	// MinUpgradeIntervalMs 防止过密拉起子进程压垮系统。
	MinUpgradeIntervalMs int64 = 5 * 60 * 1000
)

// ErrAlreadyRunning 表示已有升级周期或解除熔断操作正在占用账本。
var ErrAlreadyRunning = errors.New("already_running")

// SchedulerConfig 描述升级调度器运行配置。
type SchedulerConfig struct {
	Enabled          *bool
	ApplyEnabled     *bool
	StartDelayMs     *int64
	IntervalMs       int64
	SoakMs           *int64
	SoakUnknownLimit *int64
}

type normalizedSchedulerConfig struct {
	Enabled          bool
	ApplyEnabled     bool
	StartDelayMs     int64
	IntervalMs       int64
	SoakMs           int64
	SoakUnknownLimit int64
}

func normalizeSchedulerConfig(raw SchedulerConfig) normalizedSchedulerConfig {
	enabled := true
	if raw.Enabled != nil {
		enabled = *raw.Enabled
	}
	applyEnabled := true
	if raw.ApplyEnabled != nil {
		applyEnabled = *raw.ApplyEnabled
	}
	startDelayMs := DefaultUpgradeStartDelayMs
	if raw.StartDelayMs != nil && *raw.StartDelayMs >= 0 {
		startDelayMs = *raw.StartDelayMs
	}
	intervalMs := raw.IntervalMs
	if intervalMs < MinUpgradeIntervalMs {
		intervalMs = DefaultUpgradeIntervalMs
	}
	soakMs := DefaultSoakMs
	if raw.SoakMs != nil && *raw.SoakMs >= 0 {
		soakMs = *raw.SoakMs
	}
	soakUnknownLimit := DefaultSoakUnknownLimit
	if raw.SoakUnknownLimit != nil && *raw.SoakUnknownLimit >= 1 {
		soakUnknownLimit = *raw.SoakUnknownLimit
	}
	return normalizedSchedulerConfig{
		Enabled:          enabled,
		ApplyEnabled:     applyEnabled,
		StartDelayMs:     startDelayMs,
		IntervalMs:       intervalMs,
		SoakMs:           soakMs,
		SoakUnknownLimit: soakUnknownLimit,
	}
}

// TickProviderOutcome 记录单轮周期内某个 provider 的结论。
type TickProviderOutcome struct {
	State  string `json:"state"`
	Reason string `json:"reason"`
}

// LastResult 描述最近一次完成的周期 tick 快照。
type LastResult struct {
	At           int64                          `json:"at"`
	Reason       string                         `json:"reason"`
	ApplyEnabled bool                           `json:"applyEnabled"`
	Providers    map[string]TickProviderOutcome `json:"providers"`
}

// SchedulerState 是 /v1/management/webui/provider-cli-upgrade 中 scheduler 字段的精确运行态快照。
type SchedulerState struct {
	Running          bool        `json:"running"`
	Cycling          bool        `json:"cycling"`
	ApplyingProvider string      `json:"applyingProvider"`
	Enabled          bool        `json:"enabled"`
	ApplyEnabled     bool        `json:"applyEnabled"`
	StartDelayMs     int64       `json:"startDelayMs"`
	IntervalMs       int64       `json:"intervalMs"`
	Providers        []string    `json:"providers"`
	TickCount        int64       `json:"tickCount"`
	LastResult       *LastResult `json:"lastResult"`
	LastError        string      `json:"lastError"`
}

// RunResult 表示 RunNow 的返回结果。
type RunResult struct {
	OK        bool
	Skipped   bool
	Reason    string
	Error     string
	Providers map[string]TickProviderOutcome
}

// SchedulerOptions 配置 Provider CLI 自动升级周期调度器。
type SchedulerOptions struct {
	AIHomeDir    string
	Catalog      *providers.Catalog
	Providers    []string
	CycleDeps    *CycleDeps
	ClearVerify  ClearBrokenVerifier
	RealDeps     *RealDeps
	GoOS         string
	BaseEnv      map[string]string
	Config       SchedulerConfig
	RunCycleFn   func(ctx context.Context, provider string, ledger Ledger, deps CycleDeps, cfg CycleConfig) CycleOutcome
	ReadLedgerFn func(aiHomeDir string) Ledger
	WriteLedgerFn func(aiHomeDir string, ledger Ledger) error
	Now          func() int64
	LogInfo      func(msg string)
	LogWarn      func(msg string)
}

// Scheduler 驱动各候选 provider 的串行升级周期与互斥 clear-broken 入口。
type Scheduler struct {
	aiHomeDir    string
	catalog      *providers.Catalog
	providers    []string
	cycleDeps    *CycleDeps
	clearVerify  ClearBrokenVerifier
	goos         string
	baseEnv      map[string]string
	runCycleFn   func(ctx context.Context, provider string, ledger Ledger, deps CycleDeps, cfg CycleConfig) CycleOutcome
	readLedgerFn func(aiHomeDir string) Ledger
	writeLedgerFn func(aiHomeDir string, ledger Ledger) error
	now          func() int64
	logInfo      func(msg string)
	logWarn      func(msg string)

	mu               sync.Mutex
	config           normalizedSchedulerConfig
	running          bool
	cycling          bool
	applyingProvider string
	tickCount        int64
	lastResult       *LastResult
	lastError        string
	stopCh           chan struct{}
	loopDone         chan struct{}
}

// NewScheduler 创建 Provider CLI 自动升级调度器；Start 后在后台按配置节奏触发检查。
func NewScheduler(opts SchedulerOptions) *Scheduler {
	cands := append([]string(nil), opts.Providers...)
	if len(cands) == 0 && opts.Catalog != nil {
		cands = ListUpgradeCandidateProviders(opts.Catalog)
	}
	var cDeps *CycleDeps
	if opts.CycleDeps != nil {
		copied := *opts.CycleDeps
		cDeps = &copied
	}
	clearVerify := opts.ClearVerify
	if opts.RealDeps != nil {
		if cDeps == nil {
			realCycleDeps := opts.RealDeps.CycleDeps()
			cDeps = &realCycleDeps
		}
		if clearVerify == nil {
			clearVerify = opts.RealDeps
		}
	}
	runCycleFn := opts.RunCycleFn
	if runCycleFn == nil {
		runCycleFn = RunProviderCycle
	}
	readFn := opts.ReadLedgerFn
	if readFn == nil {
		readFn = ReadLedger
	}
	writeFn := opts.WriteLedgerFn
	if writeFn == nil {
		writeFn = WriteLedger
	}
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = func() int64 { return time.Now().UnixMilli() }
	}
	logInfo := opts.LogInfo
	if logInfo == nil {
		logInfo = func(string) {}
	}
	logWarn := opts.LogWarn
	if logWarn == nil {
		logWarn = func(string) {}
	}
	return &Scheduler{
		aiHomeDir:     strings.TrimSpace(opts.AIHomeDir),
		catalog:       opts.Catalog,
		providers:     cands,
		cycleDeps:     cDeps,
		clearVerify:   clearVerify,
		goos:          opts.GoOS,
		baseEnv:       opts.BaseEnv,
		runCycleFn:    runCycleFn,
		readLedgerFn:  readFn,
		writeLedgerFn: writeFn,
		now:           nowFn,
		logInfo:       logInfo,
		logWarn:       logWarn,
		config:        normalizeSchedulerConfig(opts.Config),
	}
}

// Start 启动调度器（幂等）；若 config.Enabled 为 false 则保持 running=true 但不启动定时器。
func (s *Scheduler) Start(ctx context.Context) SchedulerState {
	if ctx == nil {
		ctx = context.Background()
	}
	s.mu.Lock()
	if s.running {
		state := s.snapshotLocked()
		s.mu.Unlock()
		return state
	}
	s.running = true
	cfg := s.config
	if !cfg.Enabled {
		state := s.snapshotLocked()
		s.mu.Unlock()
		return state
	}
	stopCh := make(chan struct{})
	loopDone := make(chan struct{})
	s.stopCh = stopCh
	s.loopDone = loopDone
	state := s.snapshotLocked()
	s.mu.Unlock()

	go s.runLoop(ctx, cfg.StartDelayMs, cfg.IntervalMs, stopCh, loopDone)
	return state
}

// Stop 停止定时器并等待后台循环退出（不持锁等待避免死锁）。
func (s *Scheduler) Stop() SchedulerState {
	s.mu.Lock()
	if !s.running {
		state := s.snapshotLocked()
		s.mu.Unlock()
		return state
	}
	s.running = false
	stopCh := s.stopCh
	loopDone := s.loopDone
	s.stopCh = nil
	s.loopDone = nil
	s.mu.Unlock()

	if stopCh != nil {
		close(stopCh)
	}
	if loopDone != nil {
		<-loopDone
	}
	return s.State()
}

// Close 实现 io.Closer，便于宿主 Server.Close 统一回收资源。
func (s *Scheduler) Close() error {
	if s != nil {
		s.Stop()
	}
	return nil
}

func (s *Scheduler) runLoop(ctx context.Context, startDelayMs int64, intervalMs int64, stopCh <-chan struct{}, doneCh chan<- struct{}) {
	defer close(doneCh)

	if startDelayMs <= 0 {
		s.RunNow(ctx, "startup")
	} else {
		delayTimer := time.NewTimer(time.Duration(startDelayMs) * time.Millisecond)
		select {
		case <-ctx.Done():
			delayTimer.Stop()
			return
		case <-stopCh:
			delayTimer.Stop()
			return
		case <-delayTimer.C:
			s.RunNow(ctx, "startup")
		}
	}

	ticker := time.NewTicker(time.Duration(intervalMs) * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-stopCh:
			return
		case <-ticker.C:
			s.RunNow(ctx, "interval")
		}
	}
}

// RunNow 串行执行一轮全量 provider 升级检查/应用，并在每个 provider 结束后立即原子落盘账本。
func (s *Scheduler) RunNow(ctx context.Context, reason string) RunResult {
	if ctx == nil {
		ctx = context.Background()
	}
	if strings.TrimSpace(reason) == "" {
		reason = "manual"
	}

	s.mu.Lock()
	cfg := s.config
	if !cfg.Enabled {
		s.mu.Unlock()
		return RunResult{OK: false, Skipped: true, Reason: "disabled"}
	}
	if s.cycleDeps == nil {
		s.mu.Unlock()
		return RunResult{OK: false, Skipped: true, Reason: "deps_unavailable"}
	}
	if len(s.providers) == 0 {
		s.mu.Unlock()
		return RunResult{OK: false, Skipped: true, Reason: "no_candidates"}
	}
	if s.cycling {
		s.mu.Unlock()
		return RunResult{OK: false, Skipped: true, Reason: "already_running"}
	}
	s.cycling = true
	deps := *s.cycleDeps
	providersList := append([]string(nil), s.providers...)
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		s.applyingProvider = ""
		s.cycling = false
		s.mu.Unlock()
	}()

	cycleCfg := CycleConfig{
		ApplyEnabled:     cfg.ApplyEnabled,
		GoOS:             s.goos,
		BaseEnv:          s.baseEnv,
		SoakMs:           cfg.SoakMs,
		SoakUnknownLimit: cfg.SoakUnknownLimit,
	}

	ledger := s.readLedgerFn(s.aiHomeDir)
	outcomes := make(map[string]TickProviderOutcome, len(providersList))

	for _, provider := range providersList {
		s.mu.Lock()
		s.applyingProvider = provider
		s.mu.Unlock()

		outcome := s.runProviderIsolated(ctx, provider, ledger, deps, cycleCfg)
		ledger = outcome.Ledger
		outcomes[provider] = TickProviderOutcome{
			State:  outcome.State,
			Reason: outcome.Reason,
		}
		if outcome.State == "error" {
			msg := fmt.Sprintf("%s: %s", provider, outcome.Reason)
			s.mu.Lock()
			if s.lastError != msg {
				s.logWarn("provider cli upgrade cycle failed (" + msg + ")")
			}
			s.lastError = msg
			s.mu.Unlock()
		}

		s.mu.Lock()
		s.applyingProvider = ""
		s.mu.Unlock()

		if err := s.writeLedgerFn(s.aiHomeDir, ledger); err != nil {
			msg := fmt.Sprintf("%s: %v", provider, err)
			s.mu.Lock()
			s.lastError = msg
			s.mu.Unlock()
			s.logWarn("provider cli upgrade ledger write failed (" + msg + ")")
		}
	}

	hasError := false
	summaryParts := make([]string, 0, len(providersList))
	for _, p := range providersList {
		o := outcomes[p]
		if o.State == "error" {
			hasError = true
		}
		summaryParts = append(summaryParts, p+"="+o.Reason)
	}

	copiedOutcomes := make(map[string]TickProviderOutcome, len(outcomes))
	for k, v := range outcomes {
		copiedOutcomes[k] = v
	}

	at := currentEpochMs(s.now)
	s.mu.Lock()
	s.tickCount++
	if !hasError {
		s.lastError = ""
	}
	s.lastResult = &LastResult{
		At:           at,
		Reason:       reason,
		ApplyEnabled: cycleCfg.ApplyEnabled,
		Providers:    copiedOutcomes,
	}
	s.mu.Unlock()

	modeSuffix := ""
	if !cycleCfg.ApplyEnabled {
		modeSuffix = ", check-only"
	}
	s.logInfo(fmt.Sprintf("provider cli upgrade tick (%s%s): %s", reason, modeSuffix, strings.Join(summaryParts, " ")))
	return RunResult{OK: true, Providers: outcomes}
}

func (s *Scheduler) runProviderIsolated(
	ctx context.Context,
	provider string,
	ledger Ledger,
	deps CycleDeps,
	cfg CycleConfig,
) (res CycleOutcome) {
	defer func() {
		if r := recover(); r != nil {
			res = CycleOutcome{
				OK:     false,
				Ledger: ledger,
				State:  "error",
				Reason: fmt.Sprintf("panic:%v\n%s", r, string(debug.Stack())),
			}
		}
	}()
	outcome := s.runCycleFn(ctx, provider, ledger, deps, cfg)
	if len(outcome.Ledger.Providers) == 0 && ledger.Providers != nil {
		outcome.Ledger = ledger
	}
	return outcome
}

// TryRunExclusive 占用调度器 cycling 互斥锁执行人工操作（如 clear-broken），防止与后台 tick 踩踏同一账本。
func (s *Scheduler) TryRunExclusive(fn func() error) error {
	if s == nil {
		return fn()
	}
	s.mu.Lock()
	if s.cycling {
		s.mu.Unlock()
		return ErrAlreadyRunning
	}
	s.cycling = true
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		s.cycling = false
		s.mu.Unlock()
	}()
	return fn()
}

// ClearBroken 通过调度器互斥锁执行 clear-broken 流程并持久化账本。
func (s *Scheduler) ClearBroken(ctx context.Context, provider string, verifierOverride ClearBrokenVerifier) ClearBrokenResult {
	target := strings.ToLower(strings.TrimSpace(provider))
	if !containsString(s.providers, target) {
		return ClearBrokenResult{OK: false, Reason: "unknown_provider"}
	}
	verifier := verifierOverride
	if verifier == nil {
		verifier = s.clearVerify
	}
	var out ClearBrokenResult
	if err := s.TryRunExclusive(func() error {
		ledger := s.readLedgerFn(s.aiHomeDir)
		out = ClearBrokenProvider(ctx, target, ledger, verifier, currentEpochMs(s.now))
		if out.OK {
			if err := s.writeLedgerFn(s.aiHomeDir, out.Ledger); err != nil {
				out = ClearBrokenResult{
					OK:       false,
					Ledger:   ledger,
					Reason:   "ledger_write_failed",
					Detail:   err.Error(),
					Version:  out.Version,
					Verified: out.Verified,
				}
				return nil
			}
		}
		return nil
	}); errors.Is(err, ErrAlreadyRunning) {
		return ClearBrokenResult{OK: false, Reason: "already_running"}
	}
	s.logInfo(fmt.Sprintf("provider cli upgrade clear-broken %s: %s", target, out.Reason))
	return out
}

// Verifier 返回调度器内置的 ClearBrokenVerifier。
func (s *Scheduler) Verifier() ClearBrokenVerifier {
	if s == nil {
		return nil
	}
	return s.clearVerify
}

// State 返回当前线程安全的调度器运行态快照。
func (s *Scheduler) State() SchedulerState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.snapshotLocked()
}

// StatusSnapshot 返回含实时调度器态的完整 WebUI 升级状态投影。
func (s *Scheduler) StatusSnapshot() map[string]any {
	state := s.State()
	return ProjectStatus(s.aiHomeDir, s.catalog, &state)
}

func (s *Scheduler) snapshotLocked() SchedulerState {
	providersCopy := make([]string, len(s.providers))
	copy(providersCopy, s.providers)
	var lastResultCopy *LastResult
	if s.lastResult != nil {
		providersMap := make(map[string]TickProviderOutcome, len(s.lastResult.Providers))
		for k, v := range s.lastResult.Providers {
			providersMap[k] = v
		}
		lastResultCopy = &LastResult{
			At:           s.lastResult.At,
			Reason:       s.lastResult.Reason,
			ApplyEnabled: s.lastResult.ApplyEnabled,
			Providers:    providersMap,
		}
	}
	return SchedulerState{
		Running:          s.running,
		Cycling:          s.cycling,
		ApplyingProvider: s.applyingProvider,
		Enabled:          s.config.Enabled,
		ApplyEnabled:     s.config.ApplyEnabled,
		StartDelayMs:     s.config.StartDelayMs,
		IntervalMs:       s.config.IntervalMs,
		Providers:        providersCopy,
		TickCount:        s.tickCount,
		LastResult:       lastResultCopy,
		LastError:        s.lastError,
	}
}

func currentEpochMs(nowFn func() int64) int64 {
	if nowFn != nil {
		return nowFn()
	}
	return time.Now().UnixMilli()
}
