package usagedaemons

import (
	"context"
	"math/rand/v2"
	"sync"
	"time"
)

const (
	// DefaultUsageScanStartDelay 是服务启动后首次执行全量模型用量扫描的默认延迟。
	DefaultUsageScanStartDelay = 5 * time.Second
	// DefaultUsageScanInterval 是全量模型用量扫描的基准周期（10 分钟）。
	DefaultUsageScanInterval = 10 * time.Minute
	// MinUsageScanInterval 是用量扫描允许配置的最小基准间隔（1 分钟）。
	MinUsageScanInterval = time.Minute
)

// UsageScanRequest 描述单次用量扫描触发的上下文与参数。
type UsageScanRequest struct {
	ReindexCodexForkHistory bool   `json:"reindexCodexForkHistory"`
	Reason                  string `json:"reason"`
}

// UsageScanResult 封装端口返回的扫描计量统计与扩展摘要。
type UsageScanResult struct {
	RecordsScanned int            `json:"recordsScanned"`
	FilesScanned   int            `json:"filesScanned"`
	Summary        map[string]any `json:"summary,omitempty"`
}

// UsageScanOutcome 表示 Trigger 调用结果，包含是否跳过与失败原因。
type UsageScanOutcome struct {
	OK         bool            `json:"ok"`
	Skipped    bool            `json:"skipped,omitempty"`
	SkipReason string          `json:"skipReason,omitempty"`
	Error      string          `json:"error,omitempty"`
	Result     UsageScanResult `json:"result"`
}

// UsageScanSnapshot 记录最近一次成功扫描的快照（与 model-usage-scheduler.js 对齐）。
type UsageScanSnapshot struct {
	At      int64           `json:"at"`
	Reason  string          `json:"reason"`
	Result  UsageScanResult `json:"result"`
	Pricing map[string]any  `json:"pricing,omitempty"`
}

// UsageScanPort 定义全量用量扫描与价格表过时同步的底层能力端口。
type UsageScanPort interface {
	ScanUsage(ctx context.Context, req UsageScanRequest) (UsageScanResult, error)
	SyncPricingIfStale(ctx context.Context) (map[string]any, error)
}

// UsageScanSchedulerOptions 配置用量扫描调度器的节拍与外部钩子。
type UsageScanSchedulerOptions struct {
	Enabled             *bool
	StartDelay          *time.Duration
	Interval            time.Duration
	Port                UsageScanPort
	OnTokenUsageUpdated func(ctx context.Context, reason string, res UsageScanResult) error
	OnScanComplete      func(ctx context.Context, reason string, res UsageScanResult) error
	Now                 func() time.Time
	RandInt64           func(n int64) int64

	testInitialCh <-chan time.Time
	testLoopCh    <-chan time.Time
}

// UsageScanState 暴露用量扫描调度器的运行状态快照。
type UsageScanState struct {
	Running       bool               `json:"running"`
	Scanning      bool               `json:"scanning"`
	Enabled       bool               `json:"enabled"`
	PortAvailable bool               `json:"portAvailable"`
	StartDelayMs  int64              `json:"startDelayMs"`
	IntervalMs    int64              `json:"intervalMs"`
	ScanCount     int64              `json:"scanCount"`
	LastRunAt     int64              `json:"lastRunAt"`
	LastResult    *UsageScanSnapshot `json:"lastResult,omitempty"`
	LastError     string             `json:"lastError,omitempty"`
}

// UsageScanScheduler 实现非重叠、带 [interval, 1.5*interval] 抖动的后台用量扫描循环。
type UsageScanScheduler struct {
	enabled        bool
	startDelay     time.Duration
	interval       time.Duration
	port           UsageScanPort
	onTokenUpdated func(context.Context, string, UsageScanResult) error
	onComplete     func(context.Context, string, UsageScanResult) error
	now            func() time.Time
	randInt64      func(int64) int64
	testInitialCh  <-chan time.Time
	testLoopCh     <-chan time.Time

	mu         sync.Mutex
	running    bool
	scanning   bool
	cancel     context.CancelFunc
	doneCh     chan struct{}
	scanCount  int64
	lastRunAt  int64
	lastResult *UsageScanSnapshot
	lastError  string
}

// NewUsageScanScheduler 创建未启动的模型用量扫描后台调度器。
func NewUsageScanScheduler(opts UsageScanSchedulerOptions) *UsageScanScheduler {
	enabled := true
	if opts.Enabled != nil {
		enabled = *opts.Enabled
	}
	startDelay := DefaultUsageScanStartDelay
	if opts.StartDelay != nil && *opts.StartDelay >= 0 {
		startDelay = *opts.StartDelay
	}
	interval := opts.Interval
	if interval <= 0 {
		interval = DefaultUsageScanInterval
	} else if interval < MinUsageScanInterval {
		interval = MinUsageScanInterval
	}
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	randFn := opts.RandInt64
	if randFn == nil {
		randFn = func(n int64) int64 {
			if n <= 0 {
				return 0
			}
			return rand.Int64N(n)
		}
	}
	return &UsageScanScheduler{
		enabled:        enabled,
		startDelay:     startDelay,
		interval:       interval,
		port:           opts.Port,
		onTokenUpdated: opts.OnTokenUsageUpdated,
		onComplete:     opts.OnScanComplete,
		now:            nowFn,
		randInt64:      randFn,
		testInitialCh:  opts.testInitialCh,
		testLoopCh:     opts.testLoopCh,
	}
}

// Start 幂等启动首次延迟扫描与错峰抖动循环。
func (s *UsageScanScheduler) Start(ctx context.Context) {
	if ctx == nil {
		ctx = context.Background()
	}
	s.mu.Lock()
	if s.running || !s.enabled {
		s.mu.Unlock()
		return
	}
	runCtx, cancel := context.WithCancel(ctx)
	doneCh := make(chan struct{})
	s.running = true
	s.cancel = cancel
	s.doneCh = doneCh
	s.mu.Unlock()

	go s.loop(runCtx, doneCh)
}

func (s *UsageScanScheduler) nextJitteredInterval() time.Duration {
	minNs := s.interval.Nanoseconds()
	maxNs := (s.interval * 3 / 2).Nanoseconds()
	if maxNs <= minNs {
		return s.interval
	}
	delta := s.randInt64(maxNs - minNs + 1)
	return time.Duration(minNs + delta)
}

func (s *UsageScanScheduler) loop(ctx context.Context, doneCh chan struct{}) {
	defer func() {
		close(doneCh)
		s.mu.Lock()
		s.running = false
		s.cancel = nil
		s.doneCh = nil
		s.mu.Unlock()
	}()

	var wg sync.WaitGroup
	defer wg.Wait()

	// 1) startup 一次性延迟触发
	wg.Add(1)
	go func() {
		defer wg.Done()
		if s.testInitialCh != nil {
			select {
			case <-ctx.Done():
				return
			case <-s.testInitialCh:
				_ = s.Trigger(ctx, "startup")
			}
			return
		}
		timer := time.NewTimer(s.startDelay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			_ = s.Trigger(ctx, "startup")
		}
	}()

	// 2) [interval, 1.5*interval] 错峰循环（首次间隔 startDelay + interval）
	if s.testLoopCh != nil {
		for {
			select {
			case <-ctx.Done():
				return
			case <-s.testLoopCh:
				if ctx.Err() != nil {
					return
				}
				_ = s.Trigger(ctx, "interval")
			}
		}
	}

	delay := s.startDelay + s.interval
	for {
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			if ctx.Err() != nil {
				return
			}
			_ = s.Trigger(ctx, "interval")
			delay = s.nextJitteredInterval()
		}
	}
}

// Trigger 执行一轮非重叠的模型用量扫描、过时价格同步及后置钩子。
func (s *UsageScanScheduler) Trigger(ctx context.Context, reason string) UsageScanOutcome {
	if ctx == nil {
		ctx = context.Background()
	}
	if reason == "" {
		reason = "manual"
	}
	s.mu.Lock()
	if !s.enabled {
		s.mu.Unlock()
		return UsageScanOutcome{OK: false, Skipped: true, SkipReason: "disabled"}
	}
	if s.port == nil {
		s.mu.Unlock()
		return UsageScanOutcome{OK: false, Skipped: true, SkipReason: "service_unavailable"}
	}
	if s.scanning {
		s.mu.Unlock()
		return UsageScanOutcome{OK: false, Skipped: true, SkipReason: "already_running"}
	}
	s.scanning = true
	s.mu.Unlock()

	res, scanErr := s.port.ScanUsage(ctx, UsageScanRequest{
		ReindexCodexForkHistory: false,
		Reason:                  reason,
	})
	if scanErr != nil {
		s.mu.Lock()
		s.scanning = false
		s.lastRunAt = s.now().UnixMilli()
		s.lastError = scanErr.Error()
		s.mu.Unlock()
		return UsageScanOutcome{OK: false, Error: scanErr.Error()}
	}

	var pricing map[string]any
	if pricingRes, err := s.port.SyncPricingIfStale(ctx); err != nil {
		pricing = map[string]any{"ok": false, "error": err.Error()}
	} else {
		pricing = pricingRes
	}
	if s.onTokenUpdated != nil {
		_ = s.onTokenUpdated(ctx, reason, res)
	}
	if s.onComplete != nil {
		_ = s.onComplete(ctx, reason, res)
	}

	at := s.now().UnixMilli()
	snapshot := &UsageScanSnapshot{
		At:      at,
		Reason:  reason,
		Result:  res,
		Pricing: pricing,
	}

	s.mu.Lock()
	s.scanning = false
	s.scanCount++
	s.lastRunAt = at
	s.lastResult = snapshot
	s.lastError = ""
	s.mu.Unlock()
	return UsageScanOutcome{OK: true, Result: res}
}

// State 返回用量扫描调度器的并发安全状态快照。
func (s *UsageScanScheduler) State() UsageScanState {
	s.mu.Lock()
	defer s.mu.Unlock()
	var lastCopy *UsageScanSnapshot
	if s.lastResult != nil {
		cp := *s.lastResult
		lastCopy = &cp
	}
	return UsageScanState{
		Running:       s.running,
		Scanning:      s.scanning,
		Enabled:       s.enabled,
		PortAvailable: s.port != nil,
		StartDelayMs:  s.startDelay.Milliseconds(),
		IntervalMs:    s.interval.Milliseconds(),
		ScanCount:     s.scanCount,
		LastRunAt:     s.lastRunAt,
		LastResult:    lastCopy,
		LastError:     s.lastError,
	}
}

// Stop 通知用量扫描循环退出并等待其完成。
func (s *UsageScanScheduler) Stop() {
	s.mu.Lock()
	cancel := s.cancel
	doneCh := s.doneCh
	s.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	if doneCh != nil {
		<-doneCh
	}
}

// Close 实现 io.Closer，清理后台扫描协程。
func (s *UsageScanScheduler) Close() error {
	s.Stop()
	return nil
}
