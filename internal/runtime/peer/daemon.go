package peer

import (
	"context"
	"strings"
	"sync"
	"time"
)

const (
	// DefaultDispatchInterval 是后台 peer 空闲补投守护的默认轮询间隔。
	DefaultDispatchInterval = 3 * time.Second
	// MinDispatchInterval 是保护事件循环和 tmux 的最小允许轮询间隔。
	MinDispatchInterval = time.Second
	// DefaultDispatchBatch 限制每次 tick 最多处理的待投递消息条数。
	DefaultDispatchBatch = 5
)

// DispatchDaemonOptions 配置 peer 后台补投守护进程的参数与依赖端口。
type DispatchDaemonOptions struct {
	AIHomeDir   string
	HostHomeDir string
	Getenv      func(string) string
	Interval    time.Duration
	Batch       int
	ExpireAge   time.Duration
	Delivery    DeliveryOptions
	Now         func() time.Time
	OnSummary   func(FlushSummary)

	// testTickCh 仅用于单元测试驱动确定性节拍，不走 1s 定时器。
	testTickCh <-chan time.Time
}

// DispatchDaemonState 暴露守护进程的可观测运行快照。
type DispatchDaemonState struct {
	Running     bool         `json:"running"`
	Ticking     bool         `json:"ticking"`
	IntervalMs  int64        `json:"intervalMs"`
	Batch       int          `json:"batch"`
	AIHomeDir   string       `json:"aiHomeDir"`
	TickCount   int64        `json:"tickCount"`
	LastRunAt   int64        `json:"lastRunAt"`
	LastError   string       `json:"lastError,omitempty"`
	LastSummary FlushSummary `json:"lastSummary"`
}

// DispatchDaemon 周期执行无等待（timeout=0）的 peer 收件箱单点补投。
type DispatchDaemon struct {
	store     *DispatchStore
	aiHomeDir string
	interval  time.Duration
	batch     int
	expireAge time.Duration
	delivery  DeliveryOptions
	now       func() time.Time
	onSummary func(FlushSummary)
	testTick  <-chan time.Time

	mu          sync.Mutex
	running     bool
	ticking     bool
	cancel      context.CancelFunc
	doneCh      chan struct{}
	tickCount   int64
	lastRunAt   int64
	lastError   string
	lastSummary FlushSummary
}

// NewDispatchDaemon 创建未启动的 peer 补投守护实例，便于按需 Start 或测试 Tick。
func NewDispatchDaemon(opts DispatchDaemonOptions) (*DispatchDaemon, error) {
	aiHome := ResolvePeerAIHomeDir(opts.AIHomeDir, opts.HostHomeDir, opts.Getenv)
	if strings.TrimSpace(aiHome) == "" {
		return nil, ErrStoreUnavailable
	}
	interval := opts.Interval
	if interval <= 0 {
		interval = DefaultDispatchInterval
	} else if interval < MinDispatchInterval {
		interval = MinDispatchInterval
	}
	batch := opts.Batch
	if batch <= 0 {
		batch = DefaultDispatchBatch
	}
	expireAge := opts.ExpireAge
	if expireAge <= 0 {
		expireAge = DefaultExpireAge
	}
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	delivery := opts.Delivery
	if delivery.AIHomeDir == "" {
		delivery.AIHomeDir = aiHome
	}
	if delivery.HostHomeDir == "" {
		delivery.HostHomeDir = opts.HostHomeDir
	}
	if delivery.Getenv == nil {
		delivery.Getenv = opts.Getenv
	}
	if delivery.Now == nil {
		delivery.Now = nowFn
	}
	// 强制归零：守护进程按固定 tick 轮询，忙则立刻让出并下轮重试，绝不在 tick 内睡等安静期。
	delivery.Timeout = 0

	store := NewDispatchStore(aiHome, StoreOptions{Now: nowFn})
	return &DispatchDaemon{
		store:     store,
		aiHomeDir: aiHome,
		interval:  interval,
		batch:     batch,
		expireAge: expireAge,
		delivery:  delivery,
		now:       nowFn,
		onSummary: opts.OnSummary,
		testTick:  opts.testTickCh,
	}, nil
}

// StartDispatchDaemon 创建并立即启动后台 peer 补投守护协程。
func StartDispatchDaemon(ctx context.Context, opts DispatchDaemonOptions) (*DispatchDaemon, error) {
	daemon, err := NewDispatchDaemon(opts)
	if err != nil {
		return nil, err
	}
	daemon.Start(ctx)
	return daemon, nil
}

// Start 幂等启动后台定时补投循环，直到 ctx 取消或调用 Stop/Close。
func (d *DispatchDaemon) Start(ctx context.Context) {
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

	go d.loop(runCtx, doneCh)
}

func (d *DispatchDaemon) loop(ctx context.Context, doneCh chan struct{}) {
	defer func() {
		close(doneCh)
		d.mu.Lock()
		d.running = false
		d.cancel = nil
		d.doneCh = nil
		d.mu.Unlock()
	}()

	var ticker *time.Ticker
	tickCh := d.testTick
	if tickCh == nil {
		ticker = time.NewTicker(d.interval)
		tickCh = ticker.C
		defer ticker.Stop()
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-tickCh:
			if ctx.Err() != nil {
				return
			}
			_, _ = d.Tick(ctx)
		}
	}
}

// Tick 执行单轮非重叠补投；若上一轮仍在进行则立即返回上次摘要，避免堆积。
func (d *DispatchDaemon) Tick(ctx context.Context) (FlushSummary, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	d.mu.Lock()
	if d.ticking {
		last := d.lastSummary
		d.mu.Unlock()
		return last, nil
	}
	d.ticking = true
	d.mu.Unlock()

	summary, err := FlushPending(ctx, d.store, FlushOptions{
		Delivery:  d.delivery,
		Limit:     d.batch,
		ExpireAge: d.expireAge,
		Now:       d.now,
	})

	d.mu.Lock()
	d.ticking = false
	d.tickCount++
	d.lastRunAt = d.now().UnixMilli()
	if err != nil {
		d.lastError = err.Error()
	} else {
		d.lastError = ""
		d.lastSummary = summary
	}
	cb := d.onSummary
	d.mu.Unlock()

	if err == nil && cb != nil && (summary.Delivered > 0 || summary.Failed > 0) {
		cb(summary)
	}
	return summary, err
}

// State 返回当前守护进程的并发安全运行状态快照。
func (d *DispatchDaemon) State() DispatchDaemonState {
	d.mu.Lock()
	defer d.mu.Unlock()
	return DispatchDaemonState{
		Running:     d.running,
		Ticking:     d.ticking,
		IntervalMs:  d.interval.Milliseconds(),
		Batch:       d.batch,
		AIHomeDir:   d.aiHomeDir,
		TickCount:   d.tickCount,
		LastRunAt:   d.lastRunAt,
		LastError:   d.lastError,
		LastSummary: d.lastSummary,
	}
}

// Stop 通知后台补投协程停止并等待其退出。
func (d *DispatchDaemon) Stop() {
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

// Close 实现 io.Closer，安全停止后台补投守护。
func (d *DispatchDaemon) Close() error {
	d.Stop()
	return nil
}
