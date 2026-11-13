package sessionactivity

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/core/providers"
)

// DaemonOptions 配置统一的活动、会话结果与 CodeBuddy 冷却后台守护。
type DaemonOptions struct {
	AIHomeDir              string
	HostHomeDir            string
	Catalog                *providers.Catalog
	ActivityOptions        AccountActivityOptions
	FlushInterval          time.Duration
	OnSnapshotChanged      func(snapshot map[string]AccountSnapshot)
	Tmux                   TmuxRunner
	SessionPollInterval    time.Duration
	SessionRuntimeTTL      time.Duration
	TurnActiveWindow       time.Duration
	IsAccountEnabled       AccountEnabledFunc
	ResolveHarnessTurnMode func(harnessID string) string
	OutcomePollInterval    time.Duration
	RecordOutcome          OutcomeRecordFunc
	CodebuddyLimitInterval time.Duration
	OnCodebuddyLimit       CodebuddyLimitFunc
	Now                    func() time.Time
}

// Daemon 统一持有并启停 AccountActivity、原子快照落盘、持久会话探针、Cline/Kiro 结果轮询和 CodeBuddy 冷却观察。
type Daemon struct {
	aiHomeDir         string
	flushInterval     time.Duration
	onSnapshotChanged func(snapshot map[string]AccountSnapshot)
	nowFn             func() time.Time

	activity          *AccountActivity
	sessionPoller     *SessionActivityPoller
	clinePoller       *OutcomePoller
	kiroPoller        *OutcomePoller
	codebuddyObserver *CodebuddyLimitObserver

	mu      sync.Mutex
	started bool
	lastSig string
	cancel  context.CancelFunc
	wg      sync.WaitGroup
}

// NewDaemon 构造统一的 sessionactivity 守护编排器。
func NewDaemon(options DaemonOptions) *Daemon {
	nowFn := options.Now
	if nowFn == nil {
		if options.ActivityOptions.Now != nil {
			nowFn = options.ActivityOptions.Now
		} else {
			nowFn = time.Now
		}
	}
	actOpts := options.ActivityOptions
	if actOpts.Now == nil {
		actOpts.Now = nowFn
	}
	activity := NewAccountActivity(actOpts)

	flushInterval := options.FlushInterval
	if flushInterval <= 0 {
		flushInterval = DefaultFlushInterval
	}
	aiHomeDir := strings.TrimSpace(options.AIHomeDir)
	hostHomeDir := strings.TrimSpace(options.HostHomeDir)

	isAccountEnabled := options.IsAccountEnabled
	if isAccountEnabled == nil {
		isAccountEnabled = NewSQLiteAccountEnabledChecker(aiHomeDir)
	}

	sessionPoller := NewSessionActivityPoller(SessionPollerOptions{
		AIHomeDir:              aiHomeDir,
		HostHomeDir:            hostHomeDir,
		Activity:               activity,
		Catalog:                options.Catalog,
		Tmux:                   options.Tmux,
		Interval:               options.SessionPollInterval,
		TTL:                    options.SessionRuntimeTTL,
		TurnActiveWindow:       options.TurnActiveWindow,
		IsAccountEnabled:       isAccountEnabled,
		ResolveHarnessTurnMode: options.ResolveHarnessTurnMode,
		Now:                    nowFn,
	})

	clinePoller := NewClineSessionOutcomePoller(ClinePollerOptions{
		AIHomeDir:     aiHomeDir,
		HostHomeDir:   hostHomeDir,
		Interval:      options.OutcomePollInterval,
		RecordOutcome: options.RecordOutcome,
		Now:           nowFn,
	})

	kiroPoller := NewKiroSessionOutcomePoller(KiroPollerOptions{
		AIHomeDir:     aiHomeDir,
		HostHomeDir:   hostHomeDir,
		Interval:      options.OutcomePollInterval,
		RecordOutcome: options.RecordOutcome,
		Now:           nowFn,
	})

	codebuddyObserver := NewCodebuddyLimitObserver(CodebuddyLimitOptions{
		AIHomeDir:       aiHomeDir,
		HostHomeDir:     hostHomeDir,
		Interval:        options.CodebuddyLimitInterval,
		OnLimitObserved: options.OnCodebuddyLimit,
		Now:             nowFn,
	})

	return &Daemon{
		aiHomeDir:         aiHomeDir,
		flushInterval:     flushInterval,
		onSnapshotChanged: options.OnSnapshotChanged,
		nowFn:             nowFn,
		activity:          activity,
		sessionPoller:     sessionPoller,
		clinePoller:       clinePoller,
		kiroPoller:        kiroPoller,
		codebuddyObserver: codebuddyObserver,
	}
}

// Activity 返回共享的内存账号活跃状态追踪器。
func (d *Daemon) Activity() *AccountActivity {
	return d.activity
}

// SessionPoller 返回持久 CLI 会话活跃轮询器。
func (d *Daemon) SessionPoller() *SessionActivityPoller {
	return d.sessionPoller
}

// ClineOutcomePoller 返回 Cline 会话结果轮询器。
func (d *Daemon) ClineOutcomePoller() *OutcomePoller {
	return d.clinePoller
}

// KiroOutcomePoller 返回 Kiro 回合结果轮询器。
func (d *Daemon) KiroOutcomePoller() *OutcomePoller {
	return d.kiroPoller
}

// CodebuddyObserver 返回 CodeBuddy 429 冷却观察器。
func (d *Daemon) CodebuddyObserver() *CodebuddyLimitObserver {
	return d.codebuddyObserver
}

// FlushOnce 执行一次快照签名检查、变化回调和原子落盘。
func (d *Daemon) FlushOnce() error {
	snapshot := d.activity.Snapshot()
	sig := ComputeSignature(snapshot)

	d.mu.Lock()
	changed := sig != d.lastSig
	if changed {
		d.lastSig = sig
	}
	d.mu.Unlock()

	if changed && d.onSnapshotChanged != nil {
		d.onSnapshotChanged(snapshot)
	}
	if d.aiHomeDir != "" {
		return WriteActivitySnapshotAtomic(d.aiHomeDir, snapshot, d.nowFn().UnixMilli())
	}
	return nil
}

// Start 启动 1s 快照落盘循环与全部会话观察轮询器；重复调用幂等。
func (d *Daemon) Start(parent context.Context) error {
	d.mu.Lock()
	if d.started {
		d.mu.Unlock()
		return nil
	}
	if parent == nil {
		parent = context.Background()
	}
	runCtx, cancel := context.WithCancel(parent)
	d.cancel = cancel
	d.started = true
	d.mu.Unlock()

	_ = d.FlushOnce()

	d.wg.Add(1)
	go func() {
		defer d.wg.Done()
		ticker := time.NewTicker(d.flushInterval)
		defer ticker.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-ticker.C:
				_ = d.FlushOnce()
			}
		}
	}()

	d.sessionPoller.Start(runCtx)
	d.clinePoller.Start(runCtx)
	d.kiroPoller.Start(runCtx)
	d.codebuddyObserver.Start(runCtx)
	return nil
}

// Close 停止所有后台轮询器和落盘协程，并等待它们退出。
func (d *Daemon) Close() error {
	d.mu.Lock()
	if !d.started {
		d.mu.Unlock()
		return nil
	}
	cancel := d.cancel
	d.cancel = nil
	d.started = false
	d.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	d.sessionPoller.Stop()
	d.clinePoller.Stop()
	d.kiroPoller.Stop()
	d.codebuddyObserver.Stop()
	d.wg.Wait()
	return nil
}
