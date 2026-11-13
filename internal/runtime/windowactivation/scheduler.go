package windowactivation

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	// DefaultTickInterval 默认轮询周期（10 分钟）。
	DefaultTickInterval = 10 * time.Minute
	// DefaultStartDelay 默认启动后首轮延迟（3 分钟）。
	DefaultStartDelay = 3 * time.Minute
	// MinReprobeGapMs 同一账号两次探测的最小防抖间隔（45 秒）。
	MinReprobeGapMs int64 = 45 * 1000
	// DefaultBatchSize 单轮最多探测账号数。
	DefaultBatchSize = 4
)

var slowRetryOutcomes = map[string]struct{}{
	"account_not_matched": {},
	"no_probe_model":      {},
}

// AccountSnapshot 描述参与窗口激活调度的单个账号当前快照与运行态。
type AccountSnapshot struct {
	Provider         string
	AccountRef       string
	Enabled          bool
	APIKeyMode       bool
	Status           string
	RuntimeStatus    string
	RuntimeReason    string
	LastActivityAtMs int64
	UsageSnapshot    *UsageSnapshot
}

// AccountSource 提供调度器所需的账号清单与可用模型目录。
type AccountSource interface {
	ListAccounts(ctx context.Context) ([]AccountSnapshot, error)
	ListAccountModels(ctx context.Context, accountRef string) ([]string, error)
}

// DecisionInput 描述纯决策函数 decideActivation 的输入。
type DecisionInput struct {
	NowMs               int64
	Enabled             bool
	APIKeyMode          bool
	Status              string
	RuntimeStatus       string
	RuntimeReason       string
	HasSpec             bool
	View                *WindowView
	Ledger              Ledger
	LastProbeAtMs       int64
	LastActivatedAtMs   int64
	LastActivityAtMs    int64
	LastOutcome         string
	EffectiveIntervalMs int64
	MinReprobeGapMs     int64
	ProbeGraceMs        int64
	RetryBackoffMs      int64
	ActivityEpsMs       int64
}

// Decision 描述一次「探测还是跳过」的判定结论。
type Decision struct {
	Action        string `json:"action"`
	Trigger       string `json:"trigger"`
	RuntimeStatus string `json:"runtimeStatus,omitempty"`
	RuntimeReason string `json:"runtimeReason,omitempty"`
	RetryInMs     int64  `json:"retryInMs,omitempty"`
	CloseAtMs     int64  `json:"closeAtMs,omitempty"`
	RemainingMs   int64  `json:"remainingMs,omitempty"`
	ReanchorAtMs  int64  `json:"reanchorAtMs,omitempty"`
	ProbeAtMs     int64  `json:"probeAtMs,omitempty"`
	ObservedAtMs  int64  `json:"observedAtMs,omitempty"`
}

// IsBlockingRuntimeStatus 与 managementops/node runtime-view 保持同一阻塞态口径。
func IsBlockingRuntimeStatus(status string) bool {
	s := strings.ToLower(strings.TrimSpace(status))
	return s != "" && s != "healthy" && s != "unknown"
}

// DecideActivation 纯决策函数：根据账本视图与账号事实判断是立刻探测、重锚还是跳过。
func DecideActivation(input DecisionInput) Decision {
	if !input.Enabled {
		return Decision{Action: "skip", Trigger: "disabled"}
	}
	if !input.HasSpec {
		return Decision{Action: "skip", Trigger: "no_spec"}
	}
	if input.APIKeyMode {
		return Decision{Action: "skip", Trigger: "api_key_account"}
	}
	if strings.ToLower(strings.TrimSpace(input.Status)) == "down" {
		return Decision{Action: "skip", Trigger: "account_down"}
	}
	if IsBlockingRuntimeStatus(input.RuntimeStatus) {
		return Decision{
			Action:        "skip",
			Trigger:       "runtime_blocked",
			RuntimeStatus: strings.ToLower(strings.TrimSpace(input.RuntimeStatus)),
			RuntimeReason: strings.TrimSpace(input.RuntimeReason),
		}
	}

	minReprobeGapMs := input.MinReprobeGapMs
	if minReprobeGapMs <= 0 {
		minReprobeGapMs = MinReprobeGapMs
	}
	if input.NowMs-input.LastProbeAtMs < minReprobeGapMs {
		return Decision{Action: "skip", Trigger: "debounced"}
	}

	effectiveIntervalMs := input.EffectiveIntervalMs
	if effectiveIntervalMs <= 0 {
		effectiveIntervalMs = DefaultIntervalMs
	}
	retryBackoffMs := input.RetryBackoffMs
	if retryBackoffMs <= 0 {
		retryBackoffMs = ProbeRetryBackoffMs
	}
	probeGraceMs := input.ProbeGraceMs
	if probeGraceMs <= 0 {
		probeGraceMs = ProbeGraceMs
	}
	activityEpsMs := input.ActivityEpsMs
	if activityEpsMs <= 0 {
		activityEpsMs = ActivityEpsMs
	}

	if failCount := input.Ledger.ProbeFailureCount; failCount > 0 {
		outcome := strings.TrimSpace(input.LastOutcome)
		var backoffMs int64
		if _, slow := slowRetryOutcomes[outcome]; slow {
			backoffMs = effectiveIntervalMs
		} else {
			backoffMs = retryBackoffMs * failCount
			if backoffMs > effectiveIntervalMs {
				backoffMs = effectiveIntervalMs
			}
		}
		waitedMs := input.NowMs - input.LastProbeAtMs
		if waitedMs < backoffMs {
			return Decision{
				Action:    "skip",
				Trigger:   "probe_retry_backoff",
				RetryInMs: backoffMs - waitedMs,
			}
		}
	}

	var windowView WindowView
	if input.View != nil {
		windowView = *input.View
	} else {
		windowView = DescribeWindowView(input.Ledger, input.NowMs)
	}

	switch windowView.Kind {
	case "open":
		remaining := windowView.CloseAtMs - input.NowMs
		if remaining < 0 {
			remaining = 0
		}
		return Decision{
			Action:      "skip",
			Trigger:     "window_open",
			CloseAtMs:   windowView.CloseAtMs,
			RemainingMs: remaining,
		}
	case "closed":
		closeAtMs := windowView.CloseAtMs
		if closeAtMs > 0 && input.LastActivityAtMs > closeAtMs && input.LastActivityAtMs-input.LastProbeAtMs > activityEpsMs {
			return Decision{
				Action:       "skip",
				Trigger:      "user_reopened",
				ReanchorAtMs: input.LastActivityAtMs,
				CloseAtMs:    closeAtMs,
			}
		}
		if input.NowMs < closeAtMs+probeGraceMs {
			return Decision{
				Action:    "skip",
				Trigger:   "close_grace",
				CloseAtMs: closeAtMs,
				ProbeAtMs: closeAtMs + probeGraceMs,
			}
		}
		return Decision{
			Action:    "probe",
			Trigger:   "window_closed",
			CloseAtMs: closeAtMs,
		}
	case "absent":
		observedAtMs := windowView.ObservedAtMs
		if input.LastActivatedAtMs > observedAtMs {
			return Decision{
				Action:       "skip",
				Trigger:      "probe_pending_observation",
				ObservedAtMs: observedAtMs,
			}
		}
		return Decision{
			Action:       "probe",
			Trigger:      "window_absent",
			ObservedAtMs: observedAtMs,
		}
	}

	anchorAt := input.LastActivatedAtMs
	if input.Ledger.WindowAnchorAtMs > anchorAt {
		anchorAt = input.Ledger.WindowAnchorAtMs
	}
	if input.NowMs-anchorAt < effectiveIntervalMs {
		return Decision{Action: "skip", Trigger: "not_due"}
	}
	if input.LastActivityAtMs > 0 && input.NowMs-input.LastActivityAtMs < effectiveIntervalMs {
		return Decision{Action: "skip", Trigger: "activity_gate"}
	}
	return Decision{Action: "probe", Trigger: "periodic_fallback"}
}

// SchedulerConfig 配置窗口激活调度器全局开关与间隔参数。
type SchedulerConfig struct {
	Enabled           bool
	MinIntervalMs     int64
	DefaultIntervalMs int64
	TickInterval      time.Duration
	StartDelay        time.Duration
	BatchSize         int
	ProbeTimeout      time.Duration
}

// NormalizeSchedulerConfig 归一化并夹紧窗口激活调度参数。
func NormalizeSchedulerConfig(cfg SchedulerConfig) SchedulerConfig {
	minMs := cfg.MinIntervalMs
	if minMs <= 0 {
		minMs = DefaultMinIntervalMs
	}
	if minMs < FloorMinIntervalMs {
		minMs = FloorMinIntervalMs
	}
	defMs := cfg.DefaultIntervalMs
	if defMs <= 0 {
		defMs = DefaultIntervalMs
	}
	if defMs < minMs {
		defMs = minMs
	}
	tickInterval := cfg.TickInterval
	if tickInterval == 0 {
		tickInterval = DefaultTickInterval
	}
	if tickInterval < time.Duration(FloorMinIntervalMs)*time.Millisecond {
		tickInterval = time.Duration(FloorMinIntervalMs) * time.Millisecond
	}
	startDelay := cfg.StartDelay
	if startDelay < 0 {
		startDelay = 0
	}
	batchSize := cfg.BatchSize
	if batchSize <= 0 {
		batchSize = DefaultBatchSize
	}
	if batchSize > 32 {
		batchSize = 32
	}
	probeTimeout := cfg.ProbeTimeout
	if probeTimeout <= 0 {
		probeTimeout = DefaultProbeTimeout
	}
	if probeTimeout < 5*time.Second {
		probeTimeout = 5 * time.Second
	}
	if probeTimeout > 120*time.Second {
		probeTimeout = 120 * time.Second
	}
	return SchedulerConfig{
		Enabled:           cfg.Enabled,
		MinIntervalMs:     minMs,
		DefaultIntervalMs: defMs,
		TickInterval:      tickInterval,
		StartDelay:        startDelay,
		BatchSize:         batchSize,
		ProbeTimeout:      probeTimeout,
	}
}

// SchedulerOptions 汇总窗口激活调度器所需外部端口。
type SchedulerOptions struct {
	AIHomeDir     string
	Config        SchedulerConfig
	Accounts      AccountSource
	ResolveOrigin func() string
	ClientKey     func() string
	LocalHandler  http.Handler
	DispatchProbe DispatchFunc
	Now           func() time.Time
	LogInfo       func(msg string)
	LogWarn       func(msg string)
}

// ProbeOutcomeRecord 记录单个被探测账号的本轮结果。
type ProbeOutcomeRecord struct {
	AccountRef string `json:"accountRef"`
	Provider   string `json:"provider"`
	Trigger    string `json:"trigger"`
	Outcome    string `json:"outcome"`
	Matched    bool   `json:"matched"`
	Model      string `json:"model"`
	HTTPStatus *int   `json:"httpStatus,omitempty"`
}

// AccountDecisionWindowView 记录决策结果附带的窗口摘要。
type AccountDecisionWindowView struct {
	Kind        string `json:"kind"`
	CloseAtMs   int64  `json:"closeAtMs"`
	RemainingMs int64  `json:"remainingMs"`
	Source      string `json:"source"`
}

// AccountDecisionRecord 记录账号在某一轮 tick 的判定。
type AccountDecisionRecord struct {
	Provider   string                    `json:"provider"`
	AccountRef string                    `json:"accountRef"`
	Action     string                    `json:"action"`
	Trigger    string                    `json:"trigger"`
	Window     AccountDecisionWindowView `json:"window"`
}

// TickResult 记录单轮周期检查结果。
type TickResult struct {
	OK        bool                    `json:"ok"`
	Skipped   bool                    `json:"skipped,omitempty"`
	Reason    string                  `json:"reason,omitempty"`
	Error     string                  `json:"error,omitempty"`
	At        int64                   `json:"at"`
	Probed    []ProbeOutcomeRecord    `json:"probed"`
	Decisions []AccountDecisionRecord `json:"decisions"`
}

// SchedulerAccountSummary 对外暴露的最近一轮受追踪账号视图。
type SchedulerAccountSummary struct {
	Provider        string `json:"provider"`
	AccountRef      string `json:"accountRef"`
	Window          string `json:"window"`
	WindowCloseAtMs int64  `json:"windowCloseAtMs"`
	WindowSource    string `json:"windowSource"`
	Action          string `json:"action"`
	Trigger         string `json:"trigger"`
}

// SchedulerState 导出窗口激活调度器实时状态，供 WebUI 与诊断读取。
type SchedulerState struct {
	Running           bool                      `json:"running"`
	Cycling           bool                      `json:"cycling"`
	Enabled           bool                      `json:"enabled"`
	DefaultIntervalMs int64                     `json:"defaultIntervalMs"`
	MinIntervalMs     int64                     `json:"minIntervalMs"`
	TickIntervalMs    int64                     `json:"tickIntervalMs"`
	BatchSize         int                       `json:"batchSize"`
	TrackedAccounts   int                       `json:"trackedAccounts"`
	Accounts          []SchedulerAccountSummary `json:"accounts"`
	TickCount         int64                     `json:"tickCount"`
	LastTickAt        int64                     `json:"lastTickAt"`
	NextTickAt        int64                     `json:"nextTickAt"`
	Probes            int64                     `json:"probes"`
	LastResult        *TickResult               `json:"lastResult"`
	LastError         string                    `json:"lastError"`
}

// Scheduler 周期巡检开启了窗口激活的账号并按需派发极小探测。
type Scheduler struct {
	aiHomeDir     string
	accounts      AccountSource
	resolveOrigin func() string
	clientKey     func() string
	localHandler  http.Handler
	dispatch      DispatchFunc
	now           func() time.Time
	logInfo       func(string)
	logWarn       func(string)

	mu               sync.Mutex
	running          bool
	cycling          bool
	config           SchedulerConfig
	tickCount        int64
	lastTickAtMs     int64
	nextTickAtMs     int64
	totalProbes      int64
	lastResult       *TickResult
	lastError        string
	lastProbeMap     map[string]int64
	lastActivatedMap map[string]int64
	lastViews        []SchedulerAccountSummary

	cancel context.CancelFunc
	doneCh chan struct{}
}

// NewScheduler 创建窗口激活周期调度器。
func NewScheduler(opts SchedulerOptions) *Scheduler {
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	dispatchFn := opts.DispatchProbe
	if dispatchFn == nil {
		dispatchFn = DispatchProbe
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
		aiHomeDir:        strings.TrimSpace(opts.AIHomeDir),
		accounts:         opts.Accounts,
		resolveOrigin:    opts.ResolveOrigin,
		clientKey:        opts.ClientKey,
		localHandler:     opts.LocalHandler,
		dispatch:         dispatchFn,
		now:              nowFn,
		logInfo:          logInfo,
		logWarn:          logWarn,
		config:           NormalizeSchedulerConfig(opts.Config),
		lastProbeMap:     make(map[string]int64),
		lastActivatedMap: make(map[string]int64),
	}
}

// Start 启动后台周期循环（幂等）。当 config.Enabled 为 false 时保持不调度后台 tick。
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
	if !s.config.Enabled {
		state := s.snapshotLocked()
		s.mu.Unlock()
		return state
	}
	loopCtx, cancel := context.WithCancel(ctx)
	doneCh := make(chan struct{})
	s.cancel = cancel
	s.doneCh = doneCh
	startDelay := s.config.StartDelay
	tickInterval := s.config.TickInterval
	s.nextTickAtMs = s.now().Add(startDelay).UnixMilli()
	state := s.snapshotLocked()
	s.mu.Unlock()

	go s.loop(loopCtx, doneCh, startDelay, tickInterval)
	return state
}

// Stop 优雅停止后台巡检循环并等待在飞探测结束。
func (s *Scheduler) Stop() SchedulerState {
	s.mu.Lock()
	cancel := s.cancel
	doneCh := s.doneCh
	s.cancel = nil
	s.doneCh = nil
	s.running = false
	s.nextTickAtMs = 0
	s.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	if doneCh != nil {
		<-doneCh
	}
	return s.State()
}

// Close 实现 io.Closer，停止后台周期任务。
func (s *Scheduler) Close() error {
	if s == nil {
		return nil
	}
	s.Stop()
	return nil
}

// State 返回当前调度器只读快照。
func (s *Scheduler) State() SchedulerState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.snapshotLocked()
}

func (s *Scheduler) snapshotLocked() SchedulerState {
	var lastResultCopy *TickResult
	if s.lastResult != nil {
		cp := *s.lastResult
		cp.Probed = append([]ProbeOutcomeRecord(nil), s.lastResult.Probed...)
		cp.Decisions = append([]AccountDecisionRecord(nil), s.lastResult.Decisions...)
		lastResultCopy = &cp
	}
	return SchedulerState{
		Running:           s.running,
		Cycling:           s.cycling,
		Enabled:           s.config.Enabled,
		DefaultIntervalMs: s.config.DefaultIntervalMs,
		MinIntervalMs:     s.config.MinIntervalMs,
		TickIntervalMs:    s.config.TickInterval.Milliseconds(),
		BatchSize:         s.config.BatchSize,
		TrackedAccounts:   len(s.lastProbeMap),
		Accounts:          append([]SchedulerAccountSummary(nil), s.lastViews...),
		TickCount:         s.tickCount,
		LastTickAt:        s.lastTickAtMs,
		NextTickAt:        s.nextTickAtMs,
		Probes:            s.totalProbes,
		LastResult:        lastResultCopy,
		LastError:         s.lastError,
	}
}

func (s *Scheduler) loop(ctx context.Context, doneCh chan struct{}, startDelay, tickInterval time.Duration) {
	defer close(doneCh)

	initialTimer := time.NewTimer(startDelay)
	defer initialTimer.Stop()

	select {
	case <-ctx.Done():
		return
	case <-initialTimer.C:
	}

	if res := s.RunNow(ctx, "startup"); !res.OK && res.Error != "" {
		s.logWarn(fmt.Sprintf("window activation failed (startup): %s", res.Error))
	}

	ticker := time.NewTicker(tickInterval)
	defer ticker.Stop()

	for {
		s.mu.Lock()
		s.nextTickAtMs = s.now().Add(tickInterval).UnixMilli()
		s.mu.Unlock()

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if res := s.RunNow(ctx, "interval"); !res.OK && res.Error != "" {
				s.logWarn(fmt.Sprintf("window activation failed (interval): %s", res.Error))
			}
		}
	}
}

// RunNow 立即执行一轮窗口评估与批量探测（串行非重叠；全局关闭时跳过）。
func (s *Scheduler) RunNow(ctx context.Context, reason string) TickResult {
	if ctx == nil {
		ctx = context.Background()
	}
	reason = strings.TrimSpace(reason)
	if reason == "" {
		reason = "manual"
	}

	s.mu.Lock()
	if !s.config.Enabled {
		s.mu.Unlock()
		return TickResult{OK: false, Skipped: true, Reason: "disabled"}
	}
	if s.cycling {
		s.mu.Unlock()
		return TickResult{OK: false, Skipped: true, Reason: "already_running"}
	}
	s.cycling = true
	cfg := s.config
	probeCache := make(map[string]int64, len(s.lastProbeMap))
	for k, v := range s.lastProbeMap {
		probeCache[k] = v
	}
	activatedCache := make(map[string]int64, len(s.lastActivatedMap))
	for k, v := range s.lastActivatedMap {
		activatedCache[k] = v
	}
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		s.cycling = false
		s.mu.Unlock()
	}()

	var accounts []AccountSnapshot
	if s.accounts != nil {
		listed, err := s.accounts.ListAccounts(ctx)
		if err != nil {
			msg := err.Error()
			s.mu.Lock()
			if s.lastError != msg {
				s.logWarn(fmt.Sprintf("window activation tick failed (%s): %s", reason, msg))
			}
			s.lastError = msg
			s.mu.Unlock()
			return TickResult{OK: false, Error: msg}
		}
		accounts = listed
	}

	currentNowMs := s.now().UnixMilli()
	type probeCandidate struct {
		account         AccountSnapshot
		spec            ProbeSpec
		decision        Decision
		ledger          Ledger
		stored          AccountState
		lastActivatedAt int64
	}

	candidates := make([]probeCandidate, 0)
	decisions := make([]AccountDecisionRecord, 0)
	summaries := make([]SchedulerAccountSummary, 0)

	for _, account := range accounts {
		provider := NormalizeProvider(account.Provider)
		accountRef := strings.TrimSpace(account.AccountRef)
		if accountRef == "" {
			continue
		}

		accountCfg, _, cfgErr := ReadAccountConfig(ctx, s.aiHomeDir, accountRef)
		if cfgErr != nil || !accountCfg.Enabled {
			continue
		}

		spec, hasSpec := GetProbeSpec(provider)
		effectiveIntervalMs := cfg.DefaultIntervalMs
		if accountCfg.IntervalMs != nil && *accountCfg.IntervalMs > effectiveIntervalMs {
			effectiveIntervalMs = *accountCfg.IntervalMs
		}
		if effectiveIntervalMs < cfg.MinIntervalMs {
			effectiveIntervalMs = cfg.MinIntervalMs
		}

		stored, _ := ReadAccountState(ctx, s.aiHomeDir, accountRef)
		lastProbeAt := maxInt64(stored.LastProbeAt, probeCache[accountRef])
		lastActivatedAt := maxInt64(stored.LastActivatedAt, activatedCache[accountRef])

		observation := ObserveWindow(account.UsageSnapshot, spec, lastProbeAt)
		reconciled := ReconcileLedger(stored.Ledger(), observation)
		view := DescribeWindowView(reconciled, currentNowMs)
		decision := DecideActivation(DecisionInput{
			NowMs:               currentNowMs,
			Enabled:             true,
			APIKeyMode:          account.APIKeyMode,
			Status:              account.Status,
			RuntimeStatus:       account.RuntimeStatus,
			RuntimeReason:       account.RuntimeReason,
			HasSpec:             hasSpec,
			View:                &view,
			Ledger:              reconciled,
			LastProbeAtMs:       lastProbeAt,
			LastActivatedAtMs:   lastActivatedAt,
			LastActivityAtMs:    account.LastActivityAtMs,
			LastOutcome:         stored.LastOutcome,
			EffectiveIntervalMs: effectiveIntervalMs,
			MinReprobeGapMs:     MinReprobeGapMs,
			ProbeGraceMs:        ProbeGraceMs,
			RetryBackoffMs:      ProbeRetryBackoffMs,
			ActivityEpsMs:       ActivityEpsMs,
		})

		effectiveLedger := reconciled
		if decision.ReanchorAtMs > 0 {
			effectiveLedger = AnchorWindowAt(reconciled, decision.ReanchorAtMs, reconciled.WindowMinutes, "activity")
		}
		record := buildStateRecord(stored, effectiveLedger, decision, currentNowMs, lastProbeAt, lastActivatedAt, stored.LastOutcome)
		if stored.LastDecisionReason != decision.Trigger {
			detail := ""
			if decision.Trigger == "runtime_blocked" && decision.RuntimeReason != "" {
				detail = "(" + decision.RuntimeReason + ")"
			} else if view.CloseAtMs > 0 {
				detail = "(close " + time.UnixMilli(view.CloseAtMs).Format("15:04:05") + ")"
			}
			verb := "skip"
			if decision.Action == "probe" {
				verb = "due"
			}
			s.logInfo(fmt.Sprintf("window activation: %s %s %s%s", accountRef, verb, decision.Trigger, detail))
		}
		if decision.Action != "probe" && !StateRecordsEqual(stored, record) {
			s.persistState(ctx, accountRef, record, &probeCache, &activatedCache)
		}

		summaries = append(summaries, SchedulerAccountSummary{
			Provider:        provider,
			AccountRef:      accountRef,
			Window:          view.Kind,
			WindowCloseAtMs: view.CloseAtMs,
			WindowSource:    view.Source,
			Action:          decision.Action,
			Trigger:         decision.Trigger,
		})
		decisions = append(decisions, AccountDecisionRecord{
			Provider:   provider,
			AccountRef: accountRef,
			Action:     decision.Action,
			Trigger:    decision.Trigger,
			Window: AccountDecisionWindowView{
				Kind:        view.Kind,
				CloseAtMs:   view.CloseAtMs,
				RemainingMs: view.RemainingMs,
				Source:      view.Source,
			},
		})
		if decision.Action == "probe" && hasSpec {
			candidates = append(candidates, probeCandidate{
				account:         account,
				spec:            spec,
				decision:        decision,
				ledger:          effectiveLedger,
				stored:          stored,
				lastActivatedAt: lastActivatedAt,
			})
		}
	}

	limit := cfg.BatchSize
	if limit > len(candidates) {
		limit = len(candidates)
	}
	probed := make([]ProbeOutcomeRecord, 0, limit)
	for i := 0; i < limit; i++ {
		item := candidates[i]
		outcomeRec := s.probeOneAccount(ctx, item.account, item.spec, item.decision, item.ledger, item.stored, item.lastActivatedAt, cfg.ProbeTimeout, &probeCache, &activatedCache)
		probed = append(probed, outcomeRec)
	}

	tickResult := TickResult{
		OK:        true,
		Reason:    reason,
		At:        currentNowMs,
		Probed:    probed,
		Decisions: decisions,
	}

	s.mu.Lock()
	s.tickCount++
	s.lastTickAtMs = currentNowMs
	s.totalProbes += int64(len(probed))
	s.lastViews = summaries
	s.lastResult = &tickResult
	s.lastError = ""
	for ref, ts := range probeCache {
		if ts > s.lastProbeMap[ref] {
			s.lastProbeMap[ref] = ts
		}
	}
	for ref, ts := range activatedCache {
		if ts > s.lastActivatedMap[ref] {
			s.lastActivatedMap[ref] = ts
		}
	}
	s.mu.Unlock()

	if len(probed) > 0 {
		parts := make([]string, 0, len(probed))
		for _, item := range probed {
			parts = append(parts, fmt.Sprintf("%s=%s(%s)", item.AccountRef, item.Outcome, item.Trigger))
		}
		s.logInfo(fmt.Sprintf("window activation tick (%s): %s", reason, strings.Join(parts, " ")))
	}

	return tickResult
}

func (s *Scheduler) probeOneAccount(
	ctx context.Context,
	account AccountSnapshot,
	spec ProbeSpec,
	decision Decision,
	ledger Ledger,
	stored AccountState,
	lastActivatedAt int64,
	timeout time.Duration,
	probeCache *map[string]int64,
	activatedCache *map[string]int64,
) ProbeOutcomeRecord {
	provider := NormalizeProvider(account.Provider)
	accountRef := strings.TrimSpace(account.AccountRef)
	atMs := s.now().UnixMilli()

	var accountModels []string
	if s.accounts != nil {
		if models, err := s.accounts.ListAccountModels(ctx, accountRef); err == nil {
			accountModels = models
		}
	}
	resolved := ResolveProbeModel(spec, accountModels)
	if resolved.Model == "" {
		record := buildStateRecord(stored, MarkProbeFailure(ledger), decision, atMs, atMs, lastActivatedAt, "no_probe_model")
		s.persistState(ctx, accountRef, record, probeCache, activatedCache)
		return ProbeOutcomeRecord{
			AccountRef: accountRef,
			Provider:   provider,
			Trigger:    decision.Trigger,
			Outcome:    "no_probe_model",
			Matched:    false,
		}
	}

	baseURL := ""
	if s.resolveOrigin != nil {
		baseURL = s.resolveOrigin()
	}
	clientKey := ""
	if s.clientKey != nil {
		clientKey = s.clientKey()
	}

	result := s.dispatch(ctx, ProbeInput{
		BaseURL:      baseURL,
		ClientKey:    clientKey,
		Spec:         spec,
		Model:        resolved.Model,
		Provider:     provider,
		AccountRef:   accountRef,
		LocalHandler: s.localHandler,
		Timeout:      timeout,
	})

	success := result.Matched && result.OK
	outcome := "account_not_matched"
	switch {
	case success:
		outcome = "activated"
	case result.Matched:
		outcome = "matched_upstream_error"
	case strings.TrimSpace(result.Error) != "":
		outcome = strings.TrimSpace(result.Error)
	}

	canAnchor := decision.Trigger == "window_closed" || decision.Trigger == "window_absent"
	var nextLedger Ledger
	switch {
	case !success:
		nextLedger = MarkProbeFailure(ledger)
	case canAnchor:
		winMinutes := ledger.WindowMinutes
		if winMinutes <= 0 {
			winMinutes = spec.WindowMatch.WindowMinutes
		}
		nextLedger = AnchorWindowAt(ledger, atMs, winMinutes, "probe")
	default:
		nextLedger = ClearProbeFailure(ledger)
	}

	nextActivatedAt := lastActivatedAt
	if success {
		nextActivatedAt = atMs
	}
	record := buildStateRecord(stored, nextLedger, decision, atMs, atMs, nextActivatedAt, outcome)
	s.persistState(ctx, accountRef, record, probeCache, activatedCache)

	return ProbeOutcomeRecord{
		AccountRef: accountRef,
		Provider:   provider,
		Trigger:    decision.Trigger,
		Outcome:    outcome,
		Matched:    result.Matched,
		Model:      resolved.Model,
		HTTPStatus: result.HTTPStatus,
	}
}

func (s *Scheduler) persistState(
	ctx context.Context,
	accountRef string,
	record AccountState,
	probeCache *map[string]int64,
	activatedCache *map[string]int64,
) {
	if record.LastProbeAt > 0 {
		(*probeCache)[accountRef] = record.LastProbeAt
	}
	if record.LastActivatedAt > 0 {
		(*activatedCache)[accountRef] = record.LastActivatedAt
	}
	nowMs := record.LastProbeAt
	if nowMs <= 0 {
		nowMs = s.now().UnixMilli()
	}
	_ = WriteAccountState(ctx, s.aiHomeDir, accountRef, record, nowMs)
}

func buildStateRecord(
	previous AccountState,
	ledger Ledger,
	decision Decision,
	nowMs int64,
	lastProbeAt int64,
	lastActivatedAt int64,
	lastOutcome string,
) AccountState {
	reasonChanged := previous.LastDecisionAction != decision.Action || previous.LastDecisionReason != decision.Trigger
	decisionAt := previous.LastDecisionAtMs
	if reasonChanged {
		decisionAt = nowMs
	}
	return NormalizeAccountState(AccountState{
		LastProbeAt:        maxInt64(lastProbeAt, previous.LastProbeAt),
		LastActivatedAt:    maxInt64(lastActivatedAt, previous.LastActivatedAt),
		LastOutcome:        lastOutcome,
		WindowAnchorAtMs:   ledger.WindowAnchorAtMs,
		WindowMinutes:      ledger.WindowMinutes,
		WindowCloseAtMs:    ledger.WindowCloseAtMs,
		WindowSource:       ledger.WindowSource,
		WindowObservedAtMs: ledger.WindowObservedAtMs,
		ProbeFailureCount:  ledger.ProbeFailureCount,
		LastDecisionAction: decision.Action,
		LastDecisionReason: decision.Trigger,
		LastDecisionAtMs:   decisionAt,
	})
}

func maxInt64(a, b int64) int64 {
	if a >= b {
		return a
	}
	return b
}
