package retention

import (
	"context"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	// DefaultLogSweepInterval 是日志清扫守护的默认执行周期（1 小时）。
	DefaultLogSweepInterval = time.Hour
	// DefaultRuntimeSweepInterval 是运行态目录回收的默认执行周期（6 小时）。
	DefaultRuntimeSweepInterval = 6 * time.Hour
)

// ActiveAccountRefsProvider 返回当前仍然活跃的账号引用集合；ok=false 时跳过孤儿判定。
type ActiveAccountRefsProvider func(ctx context.Context) (refs []string, ok bool, err error)

// DaemonOptions 配置日志与运行态目录后台保留守护进程。
type DaemonOptions struct {
	AIHomeDir          string
	LogsDir            string
	CurrentHome        string
	Getenv             func(string) string
	Now                func() time.Time
	LogInterval        time.Duration
	RuntimeInterval    time.Duration
	MaxLogBytes        int64
	LogKeepDays        int
	LogMaxAge          time.Duration
	RetentionKeepDays  int
	ActiveRefsProvider ActiveAccountRefsProvider
	RunOnStart         *bool

	// 仅用于测试驱动周期执行，避免等待 1h/6h 真实定时器。
	testLogTickCh     <-chan time.Time
	testRuntimeTickCh <-chan time.Time
}

// DaemonState 描述保留期守护进程的运行快照。
type DaemonState struct {
	Running           bool               `json:"running"`
	LogsTicking       bool               `json:"logsTicking"`
	RuntimeTicking    bool               `json:"runtimeTicking"`
	AIHomeDir         string             `json:"aiHomeDir"`
	LogsDir           string             `json:"logsDir"`
	LogIntervalMs     int64              `json:"logIntervalMs"`
	RuntimeIntervalMs int64              `json:"runtimeIntervalMs"`
	LogTickCount      int64              `json:"logTickCount"`
	LastLogRunAt      int64              `json:"lastLogRunAt"`
	LastLogReport     LogSweepReport     `json:"lastLogReport"`
	RuntimeTickCount  int64              `json:"runtimeTickCount"`
	LastRuntimeRunAt  int64              `json:"lastRuntimeRunAt"`
	LastRuntimeError  string             `json:"lastRuntimeError,omitempty"`
	LastRuntimeReport RuntimeSweepReport `json:"lastRuntimeReport"`
}

// Daemon 统一托管启动清扫与 1h 日志 / 6h 运行态目录后台周期回收。
type Daemon struct {
	aiHomeDir         string
	logsDir           string
	currentHome       string
	getenv            func(string) string
	now               func() time.Time
	logInterval       time.Duration
	runtimeInterval   time.Duration
	maxLogBytes       int64
	logKeepDays       int
	logMaxAge         time.Duration
	retentionKeepDays int
	activeRefs        ActiveAccountRefsProvider
	runOnStart        bool
	testLogTickCh     <-chan time.Time
	testRuntimeTickCh <-chan time.Time

	mu                sync.Mutex
	running           bool
	logsTicking       bool
	runtimeTicking    bool
	cancel            context.CancelFunc
	doneCh            chan struct{}
	logTickCount      int64
	lastLogRunAt      int64
	lastLogReport     LogSweepReport
	runtimeTickCount  int64
	lastRuntimeRunAt  int64
	lastRuntimeError  string
	lastRuntimeReport RuntimeSweepReport
}

// NewDaemon 构造未启动的保留期守护实例。
func NewDaemon(opts DaemonOptions) *Daemon {
	getenv := opts.Getenv
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	aiHome := strings.TrimSpace(opts.AIHomeDir)
	logsDir := strings.TrimSpace(opts.LogsDir)
	if logsDir == "" && aiHome != "" {
		logsDir = filepath.Join(aiHome, "logs")
	}
	currentHome := strings.TrimSpace(opts.CurrentHome)
	if currentHome == "" && getenv != nil {
		currentHome = strings.TrimSpace(getenv("HOME"))
	}
	logInterval := opts.LogInterval
	if logInterval <= 0 {
		logInterval = DefaultLogSweepInterval
	}
	runtimeInterval := opts.RuntimeInterval
	if runtimeInterval <= 0 {
		runtimeInterval = DefaultRuntimeSweepInterval
	}
	maxBytes := opts.MaxLogBytes
	if maxBytes <= 0 {
		maxBytes = ResolveMaxBytes(getenv)
	}
	keepDays := opts.LogKeepDays
	if keepDays <= 0 {
		keepDays = ResolveKeepDays(getenv)
	}
	maxAge := opts.LogMaxAge
	if maxAge <= 0 {
		maxAge = ResolveMaxAge(getenv, keepDays)
	}
	retentionDays := opts.RetentionKeepDays
	if retentionDays <= 0 {
		retentionDays = ResolveRetentionDays(getenv)
	}
	runOnStart := true
	if opts.RunOnStart != nil {
		runOnStart = *opts.RunOnStart
	}
	return &Daemon{
		aiHomeDir:         aiHome,
		logsDir:           logsDir,
		currentHome:       currentHome,
		getenv:            getenv,
		now:               nowFn,
		logInterval:       logInterval,
		runtimeInterval:   runtimeInterval,
		maxLogBytes:       maxBytes,
		logKeepDays:       keepDays,
		logMaxAge:         maxAge,
		retentionKeepDays: retentionDays,
		activeRefs:        opts.ActiveRefsProvider,
		runOnStart:        runOnStart,
		testLogTickCh:     opts.testLogTickCh,
		testRuntimeTickCh: opts.testRuntimeTickCh,
		lastRuntimeReport: RuntimeSweepReport{Removed: []RemovedEntry{}},
	}
}

// StartDaemon 创建并启动保留期守护，按需立即执行一次启动清扫。
func StartDaemon(ctx context.Context, opts DaemonOptions) (*Daemon, error) {
	d := NewDaemon(opts)
	d.Start(ctx)
	return d, nil
}

// Start 幂等启动后台 1h 日志清理与 6h 运行期回收协程。
func (d *Daemon) Start(ctx context.Context) {
	if ctx == nil {
		ctx = context.Background()
	}
	d.mu.Lock()
	if d.running {
		d.mu.Unlock()
		return
	}
	runCtx, cancel := context.WithCancel(ctx)
	doneCh := make(chan struct{})
	d.running = true
	d.cancel = cancel
	d.doneCh = doneCh
	d.mu.Unlock()

	if d.runOnStart && runCtx.Err() == nil {
		_ = d.TriggerLogs(runCtx)
		_ = d.TriggerRuntime(runCtx)
	}

	go d.loop(runCtx, doneCh)
}

func (d *Daemon) loop(ctx context.Context, doneCh chan struct{}) {
	defer func() {
		close(doneCh)
		d.mu.Lock()
		d.running = false
		d.cancel = nil
		d.doneCh = nil
		d.mu.Unlock()
	}()

	var logTicker, runtimeTicker *time.Ticker
	logCh := d.testLogTickCh
	if logCh == nil {
		logTicker = time.NewTicker(d.logInterval)
		logCh = logTicker.C
		defer logTicker.Stop()
	}
	runtimeCh := d.testRuntimeTickCh
	if runtimeCh == nil {
		runtimeTicker = time.NewTicker(d.runtimeInterval)
		runtimeCh = runtimeTicker.C
		defer runtimeTicker.Stop()
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-logCh:
			if ctx.Err() != nil {
				return
			}
			_ = d.TriggerLogs(ctx)
		case <-runtimeCh:
			if ctx.Err() != nil {
				return
			}
			_ = d.TriggerRuntime(ctx)
		}
	}
}

// TriggerLogs 立即执行一轮非重叠的日志清扫。
func (d *Daemon) TriggerLogs(ctx context.Context) LogSweepReport {
	if ctx != nil && ctx.Err() != nil {
		return d.State().LastLogReport
	}
	d.mu.Lock()
	if d.logsTicking {
		last := d.lastLogReport
		d.mu.Unlock()
		return last
	}
	d.logsTicking = true
	d.mu.Unlock()

	report := SweepLogs(d.logsDir, LogSweepOptions{
		MaxBytes: d.maxLogBytes,
		KeepDays: d.logKeepDays,
		MaxAge:   d.logMaxAge,
		Now:      d.now,
	})

	d.mu.Lock()
	d.logsTicking = false
	d.logTickCount++
	d.lastLogRunAt = d.now().UnixMilli()
	d.lastLogReport = report
	d.mu.Unlock()
	return report
}

// TriggerRuntime 立即执行一轮非重叠的运行期目录回收；若活跃账号表不可读则安全跳过孤儿回收。
func (d *Daemon) TriggerRuntime(ctx context.Context) RuntimeSweepReport {
	if ctx == nil {
		ctx = context.Background()
	}
	if ctx.Err() != nil {
		return d.State().LastRuntimeReport
	}
	d.mu.Lock()
	if d.runtimeTicking {
		last := d.lastRuntimeReport
		d.mu.Unlock()
		return last
	}
	d.runtimeTicking = true
	d.mu.Unlock()

	var refs []string
	hasRefs := false
	var providerErr string
	if d.activeRefs != nil {
		loaded, ok, err := d.activeRefs(ctx)
		if err != nil {
			providerErr = err.Error()
		} else if ok {
			refs = loaded
			hasRefs = true
		}
	}

	report := SweepRuntimeDirs(RuntimeSweepOptions{
		AIHomeDir:         d.aiHomeDir,
		ActiveAccountRefs: refs,
		HasActiveRefs:     hasRefs,
		CurrentHome:       d.currentHome,
		Now:               d.now,
		KeepDays:          d.retentionKeepDays,
	})

	d.mu.Lock()
	d.runtimeTicking = false
	d.runtimeTickCount++
	d.lastRuntimeRunAt = d.now().UnixMilli()
	d.lastRuntimeError = providerErr
	d.lastRuntimeReport = report
	d.mu.Unlock()
	return report
}

// State 返回并发安全的保留期守护运行快照。
func (d *Daemon) State() DaemonState {
	d.mu.Lock()
	defer d.mu.Unlock()
	reportCopy := RuntimeSweepReport{
		Removed:    append([]RemovedEntry(nil), d.lastRuntimeReport.Removed...),
		FreedBytes: d.lastRuntimeReport.FreedBytes,
		Scanned:    d.lastRuntimeReport.Scanned,
	}
	return DaemonState{
		Running:           d.running,
		LogsTicking:       d.logsTicking,
		RuntimeTicking:    d.runtimeTicking,
		AIHomeDir:         d.aiHomeDir,
		LogsDir:           d.logsDir,
		LogIntervalMs:     d.logInterval.Milliseconds(),
		RuntimeIntervalMs: d.runtimeInterval.Milliseconds(),
		LogTickCount:      d.logTickCount,
		LastLogRunAt:      d.lastLogRunAt,
		LastLogReport:     d.lastLogReport,
		RuntimeTickCount:  d.runtimeTickCount,
		LastRuntimeRunAt:  d.lastRuntimeRunAt,
		LastRuntimeError:  d.lastRuntimeError,
		LastRuntimeReport: reportCopy,
	}
}

// Stop 通知后台清扫协程退出并等待其完全停止。
func (d *Daemon) Stop() {
	d.mu.Lock()
	cancel := d.cancel
	doneCh := d.doneCh
	d.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	if doneCh != nil {
		<-doneCh
	}
}

// Close 实现 io.Closer，清理后台保留期守护协程。
func (d *Daemon) Close() error {
	d.Stop()
	return nil
}
