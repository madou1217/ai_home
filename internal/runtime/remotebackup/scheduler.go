package remotebackup

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"
)

const (
	// DefaultTickInterval 是周期调度检测到期目标的间隔（60 秒）。
	DefaultTickInterval = 60 * time.Second
	// DefaultStartupDelay 是服务启动后首次执行增量检查的延迟（5 秒）。
	DefaultStartupDelay = 5 * time.Second
	// RetryAfterFailure 是某个目标备份失败后的重试等待窗口（5 分钟）。
	RetryAfterFailure = 5 * time.Minute
)

// RunBackupFunc 允许在测试中替换实际的多目标备份执行实现。
type RunBackupFunc func(ctx context.Context, opts RunOptions) (BackupRunResult, error)

// SchedulerOptions 配置远程备份后台调度器。
type SchedulerOptions struct {
	Service      ServiceOptions
	RunBackup    RunBackupFunc
	TickInterval time.Duration
	StartupDelay *time.Duration
	Now          func() time.Time
	Logger       BackupLogger
}

// TargetStatusSummary 是对外状态接口暴露的非敏感备份目标视图。
type TargetStatusSummary struct {
	ID                 string         `json:"id"`
	Strategy           string         `json:"strategy"`
	Enabled            bool           `json:"enabled"`
	Host               string         `json:"host"`
	Port               int            `json:"port"`
	Username           string         `json:"username"`
	RemoteDir          string         `json:"remoteDir"`
	HasIdentityFile    bool           `json:"hasIdentityFile"`
	HasPasswordEnv     bool           `json:"hasPasswordEnv"`
	HostKeyFingerprint string         `json:"hostKeyFingerprint,omitempty"`
	State              TargetRunState `json:"state"`
}

// BackupStatus 描述管理端状态接口返回的当前备份配置、目标状态和调度运行态。
type BackupStatus struct {
	Enabled         bool                  `json:"enabled"`
	Running         bool                  `json:"running"`
	SchedulerActive bool                  `json:"schedulerActive"`
	IntervalMinutes int                   `json:"intervalMinutes"`
	DebounceSeconds int                   `json:"debounceSeconds"`
	Targets         []TargetStatusSummary `json:"targets"`
}

type pendingBackupRequest struct {
	Reason    string
	Force     bool
	Full      bool
	TargetIDs []string
}

// Scheduler 实现「事件去抖 + 周期 tick + 单飞不重叠 + pending 合并」的远程备份调度。
type Scheduler struct {
	aiHomeDir    string
	runBackup    RunBackupFunc
	tickInterval time.Duration
	startupDelay time.Duration
	now          func() time.Time
	logger       BackupLogger

	mu            sync.Mutex
	baseCtx       context.Context
	started       bool
	stopped       bool
	running       bool
	pending       *pendingBackupRequest
	startupTimer  *time.Timer
	tickTicker    *time.Ticker
	tickStop      chan struct{}
	debounceTimer *time.Timer
	wg            sync.WaitGroup
}

// NewScheduler 构造远程备份调度器。
func NewScheduler(opts SchedulerOptions) *Scheduler {
	tick := opts.TickInterval
	if tick <= 0 {
		tick = DefaultTickInterval
	} else if tick < time.Second {
		tick = time.Second
	}
	startupDelay := DefaultStartupDelay
	if opts.StartupDelay != nil {
		if *opts.StartupDelay <= 0 {
			startupDelay = 0
		} else {
			startupDelay = *opts.StartupDelay
		}
	}
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = opts.Service.Now
	}
	if nowFn == nil {
		nowFn = time.Now
	}
	logger := opts.Logger
	if logger == nil {
		logger = opts.Service.Logger
	}
	runFn := opts.RunBackup
	if runFn == nil {
		svc := opts.Service
		if svc.Now == nil {
			svc.Now = nowFn
		}
		if svc.Logger == nil {
			svc.Logger = logger
		}
		runFn = func(ctx context.Context, ro RunOptions) (BackupRunResult, error) {
			return RunRemoteBackup(ctx, svc, ro)
		}
	}
	return &Scheduler{
		aiHomeDir:    strings.TrimSpace(opts.Service.AIHomeDir),
		runBackup:    runFn,
		tickInterval: tick,
		startupDelay: startupDelay,
		now:          nowFn,
		logger:       logger,
	}
}

// DueTargetIDs 按调度间隔与失败重试窗口计算当前时刻到期需要备份的目标 ID 列表。
func DueTargetIDs(config BackupConfig, state BackupState, at time.Time) []string {
	minutes := config.IntervalMinutes
	if minutes < 1 {
		minutes = 1
	}
	interval := time.Duration(minutes) * time.Minute
	var ids []string
	for _, target := range config.Targets {
		if !target.Enabled {
			continue
		}
		entry, ok := state.Targets[target.ID]
		if !ok || strings.TrimSpace(entry.LastRunAt) == "" {
			ids = append(ids, target.ID)
			continue
		}
		lastRun := parseISOTime(entry.LastRunAt)
		if strings.TrimSpace(entry.LastError) != "" {
			if at.Sub(lastRun) >= RetryAfterFailure {
				ids = append(ids, target.ID)
			}
			continue
		}
		refTime := lastRun
		if strings.TrimSpace(entry.LastOkAt) != "" {
			refTime = parseISOTime(entry.LastOkAt)
		}
		if at.Sub(refTime) >= interval {
			ids = append(ids, target.ID)
		}
	}
	return ids
}

// Start 启动延迟首次扫描与周期 tick；已停止返回 false，已启动保持幂等返回 true。
func (s *Scheduler) Start(ctx context.Context) bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return false
	}
	if s.started {
		return true
	}
	if ctx == nil {
		ctx = context.Background()
	}
	s.baseCtx = ctx
	s.started = true

	if s.startupDelay > 0 {
		s.wg.Add(1)
		s.startupTimer = time.AfterFunc(s.startupDelay, func() {
			defer s.wg.Done()
			s.mu.Lock()
			stopped := s.stopped
			runCtx := s.baseCtx
			s.startupTimer = nil
			s.mu.Unlock()
			if !stopped {
				_, _ = s.run(runCtx, "startup", false, false, nil)
			}
		})
	}

	tickStop := make(chan struct{})
	ticker := time.NewTicker(s.tickInterval)
	s.tickStop = tickStop
	s.tickTicker = ticker
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer ticker.Stop()
		for {
			select {
			case <-tickStop:
				return
			case <-ctx.Done():
				s.stopScheduling()
				return
			case <-ticker.C:
				_, _ = s.run(ctx, "interval", false, false, nil)
			}
		}
	}()
	return true
}

// Stop 取消所有定时器和去抖计时，等待进行中的备份任务安全退出。
func (s *Scheduler) Stop() {
	if s == nil {
		return
	}
	s.stopScheduling()
	s.wg.Wait()
}

// stopScheduling 只停止接收和调度，不等待；被 wg 跟踪的 worker 不能等待自身退出。
// 所有 wg.Add 都在 mu 下检查 stopped 后执行，外部 Stop 关闸后再 Wait。
func (s *Scheduler) stopScheduling() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return
	}
	s.stopped = true
	s.started = false
	s.pending = nil
	// AfterFunc 成功取消时回调不会执行，由停止方释放其预登记计数；
	// 已触发的回调则保留计数，直到回调自己的 defer Done 执行。
	if s.startupTimer != nil {
		if s.startupTimer.Stop() {
			s.wg.Done()
		}
		s.startupTimer = nil
	}
	if s.debounceTimer != nil {
		if s.debounceTimer.Stop() {
			s.wg.Done()
		}
		s.debounceTimer = nil
	}
	if s.tickTicker != nil {
		s.tickTicker.Stop()
		s.tickTicker = nil
	}
	if s.tickStop != nil {
		close(s.tickStop)
		s.tickStop = nil
	}
}

// Trigger 按配置中的 debounceSeconds 触发一次去抖强制备份；已有等待中的去抖时不重置计时器。
func (s *Scheduler) Trigger(reason string) bool {
	if s == nil || s.aiHomeDir == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return false
	}
	if s.debounceTimer != nil {
		return true
	}
	config, err := ReadBackupConfig(s.aiHomeDir)
	if err != nil || !config.Enabled || !hasEnabledTarget(config) {
		return false
	}
	debounce := config.DebounceSeconds
	if debounce < 0 {
		debounce = DefaultDebounceSeconds
	}
	resolvedReason := strings.TrimSpace(reason)
	if resolvedReason == "" {
		resolvedReason = "event"
	}
	s.wg.Add(1)
	s.debounceTimer = time.AfterFunc(time.Duration(debounce)*time.Second, func() {
		defer s.wg.Done()
		s.mu.Lock()
		if s.stopped {
			s.debounceTimer = nil
			s.mu.Unlock()
			return
		}
		s.debounceTimer = nil
		runCtx := s.baseCtx
		s.mu.Unlock()
		if runCtx == nil {
			runCtx = context.Background()
		}
		_, _ = s.run(runCtx, resolvedReason, true, false, nil)
	})
	return true
}

// RunNow 立即执行一轮强制备份（默认 force=true）；允许指定 reason、targetIds 与 full。
func (s *Scheduler) RunNow(ctx context.Context, reason string, force bool, full bool, targetIDs []string) (BackupRunResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	r := strings.TrimSpace(reason)
	if r == "" {
		r = "manual"
	}
	return s.run(ctx, r, force, full, targetIDs)
}

// RunDue 仅执行当前已到期的目标备份。
func (s *Scheduler) RunDue(ctx context.Context) (BackupRunResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	return s.run(ctx, "interval", false, false, nil)
}

// IsRunning 返回当前是否有备份正在运行中。
func (s *Scheduler) IsRunning() bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running
}

// Status 返回当前配置摘要（脱敏）、各目标最近运行态与调度器状态。
func (s *Scheduler) Status(_ context.Context) (BackupStatus, error) {
	if s == nil || s.aiHomeDir == "" {
		return BackupStatus{}, fmt.Errorf("backup scheduler 未配置 aiHomeDir")
	}
	config, err := ReadBackupConfig(s.aiHomeDir)
	if err != nil {
		return BackupStatus{}, err
	}
	state, err := ReadBackupState(s.aiHomeDir)
	if err != nil {
		return BackupStatus{}, err
	}

	s.mu.Lock()
	running := s.running
	active := s.started && !s.stopped
	s.mu.Unlock()

	targets := make([]TargetStatusSummary, 0, len(config.Targets))
	for _, target := range config.Targets {
		targets = append(targets, TargetStatusSummary{
			ID:                 target.ID,
			Strategy:           target.Strategy,
			Enabled:            target.Enabled,
			Host:               target.Host,
			Port:               target.Port,
			Username:           target.Username,
			RemoteDir:          target.RemoteDir,
			HasIdentityFile:    target.IdentityFile != "",
			HasPasswordEnv:     target.PasswordEnv != "",
			HostKeyFingerprint: target.HostKeyFingerprint,
			State:              state.Targets[target.ID],
		})
	}
	return BackupStatus{
		Enabled:         config.Enabled,
		Running:         running,
		SchedulerActive: active,
		IntervalMinutes: config.IntervalMinutes,
		DebounceSeconds: config.DebounceSeconds,
		Targets:         targets,
	}, nil
}

func (s *Scheduler) run(
	ctx context.Context,
	reason string,
	force bool,
	full bool,
	targetIDs []string,
) (BackupRunResult, error) {
	if s == nil || s.aiHomeDir == "" {
		return BackupRunResult{OK: true, Skipped: "unconfigured"}, nil
	}

	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		return BackupRunResult{OK: true, Skipped: "stopped"}, nil
	}
	if s.running {
		s.pending = &pendingBackupRequest{
			Reason:    reason,
			Force:     force,
			Full:      full,
			TargetIDs: append([]string(nil), targetIDs...),
		}
		s.mu.Unlock()
		return BackupRunResult{OK: true, Skipped: "running"}, nil
	}
	s.running = true
	// 直接调用与 timer/tick 触发的执行都纳入停机等待，登记与 stopped 共享同一把锁。
	s.wg.Add(1)
	if ctx == nil {
		ctx = context.Background()
	}
	s.mu.Unlock()

	defer s.wg.Done()
	defer s.finishRun()

	config, err := ReadBackupConfig(s.aiHomeDir)
	if err != nil {
		if s.logger != nil {
			s.logger.Warn(fmt.Sprintf("自动备份失败（%s）：%s", reason, safeBackupErrorMessage(err)))
		}
		return BackupRunResult{OK: false, Error: safeBackupErrorMessage(err)}, err
	}
	if !config.Enabled {
		return BackupRunResult{OK: true, Skipped: "disabled"}, nil
	}
	if !hasEnabledTarget(config) {
		return BackupRunResult{OK: true, Skipped: "no_targets"}, nil
	}
	state, err := ReadBackupState(s.aiHomeDir)
	if err != nil {
		return BackupRunResult{OK: false, Error: safeBackupErrorMessage(err)}, err
	}

	selectedIDs := targetIDs
	if len(selectedIDs) == 0 && !force {
		due := DueTargetIDs(config, state, s.now())
		if len(due) == 0 {
			return BackupRunResult{OK: true, Skipped: "not_due"}, nil
		}
		selectedIDs = due
	}

	result, err := s.runBackup(ctx, RunOptions{
		TargetIDs: selectedIDs,
		Full:      full,
		Config:    &config,
		State:     &state,
	})
	if err != nil {
		if s.logger != nil {
			s.logger.Warn(fmt.Sprintf("自动备份失败（%s）：%s", reason, safeBackupErrorMessage(err)))
		}
		result.OK = false
		result.Error = safeBackupErrorMessage(err)
		return result, err
	}
	if !result.OK && s.logger != nil {
		s.logger.Warn(fmt.Sprintf("自动备份部分目标失败（%s）", reason))
	}
	return result, nil
}

func (s *Scheduler) finishRun() {
	s.mu.Lock()
	s.running = false
	next := s.pending
	s.pending = nil
	stopped := s.stopped
	baseCtx := s.baseCtx
	if baseCtx == nil {
		baseCtx = context.Background()
	}
	if next != nil && !stopped {
		s.wg.Add(1)
		go func(req *pendingBackupRequest) {
			defer s.wg.Done()
			_, _ = s.run(baseCtx, req.Reason, req.Force, req.Full, req.TargetIDs)
		}(next)
	}
	s.mu.Unlock()
}

func hasEnabledTarget(config BackupConfig) bool {
	for _, target := range config.Targets {
		if target.Enabled {
			return true
		}
	}
	return false
}

func parseISOTime(raw string) time.Time {
	text := strings.TrimSpace(raw)
	if text == "" {
		return time.Time{}
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if parsed, err := time.Parse(layout, text); err == nil {
			return parsed
		}
	}
	return time.Time{}
}
