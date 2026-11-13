package usagedaemons

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	// DefaultQuotaProbeInterval 是账号额度临近重置探测的默认调度周期（60 秒）。
	DefaultQuotaProbeInterval = 60 * time.Second
	// MinQuotaProbeInterval 限制最小探测调度周期为 10 秒。
	MinQuotaProbeInterval = 10 * time.Second
	// DefaultQuotaProbeStartDelay 是启动后首次探测的延迟时间（5 秒）。
	DefaultQuotaProbeStartDelay = 5 * time.Second
	// DefaultQuotaProbeBatch 限制单轮最多探测的账号数量。
	DefaultQuotaProbeBatch = 4
	// DefaultQuotaProbeCooldown 限制同一账号两次主动探测的最小间隔（45 秒）。
	DefaultQuotaProbeCooldown = 45 * time.Second
	// DefaultQuotaProbeAheadWindow 表示距离 resetAt 不足 3 分钟或已到期时优先探测。
	DefaultQuotaProbeAheadWindow = 3 * time.Minute
	// DefaultQuotaProbeStaleAge 表示已有消耗或未知剩余的快照超过 15 分钟即复查。
	DefaultQuotaProbeStaleAge = 15 * time.Minute
	// DefaultQuotaNearResetPct 表示临近重置窗内需要主动复查的剩余额度阈值。
	DefaultQuotaNearResetPct = 95.0
)

// QuotaEntry 表示单个额度维度或模型配额的剩余百分比与重置时间戳。
type QuotaEntry struct {
	RemainingPct *float64
	ResetAtMs    int64
}

// QuotaSnapshot 表示某个账号最近一次缓存的额度快照。
type QuotaSnapshot struct {
	CapturedAtMs int64
	Entries      []QuotaEntry
}

// QuotaAccount 描述待参与后台额度探测的账号对象。
type QuotaAccount struct {
	Provider   string
	AccountRef string
	APIKeyMode bool
	Snapshot   *QuotaSnapshot
}

// QuotaAccountSource 提供参与额度探测的候选账号列表。
type QuotaAccountSource interface {
	ListQuotaAccounts(ctx context.Context) ([]QuotaAccount, error)
}

// QuotaProbePort 抽象底层 provider 额度支持判定与真实刷新调用。
type QuotaProbePort interface {
	SupportsProvider(provider string) bool
	ProbeAccountQuota(ctx context.Context, account QuotaAccount) error
}

// QuotaProbeOptions 配置额度后台探测调度器参数与端口。
type QuotaProbeOptions struct {
	Interval   time.Duration
	StartDelay *time.Duration
	BatchSize  int
	Cooldown   time.Duration
	Ahead      time.Duration
	StaleAge   time.Duration
	Source     QuotaAccountSource
	Port       QuotaProbePort
	Now        func() time.Time

	testTickCh <-chan time.Time
}

// QuotaProbeSummary 记录单轮额度探测的筛选与执行结果。
type QuotaProbeSummary struct {
	Candidates int   `json:"candidates"`
	Probed     int   `json:"probed"`
	Failed     int   `json:"failed"`
	At         int64 `json:"at"`
}

// QuotaProbeState 暴露额度探测调度器的并发安全运行状态。
type QuotaProbeState struct {
	Running     bool              `json:"running"`
	Ticking     bool              `json:"ticking"`
	Enabled     bool              `json:"enabled"`
	IntervalMs  int64             `json:"intervalMs"`
	BatchSize   int               `json:"batchSize"`
	TickCount   int64             `json:"tickCount"`
	LastRunAt   int64             `json:"lastRunAt"`
	LastError   string            `json:"lastError,omitempty"`
	LastSummary QuotaProbeSummary `json:"lastSummary"`
}

// QuotaProbeScheduler 按重置迫近度与快照陈旧度分批探测 OAuth 账号额度。
type QuotaProbeScheduler struct {
	interval    time.Duration
	startDelay  time.Duration
	batchSize   int
	cooldownMs  int64
	aheadMs     int64
	staleAgeMs  int64
	source      QuotaAccountSource
	port        QuotaProbePort
	now         func() time.Time
	testTickCh  <-chan time.Time

	mu          sync.Mutex
	running     bool
	ticking     bool
	cancel      context.CancelFunc
	doneCh      chan struct{}
	lastProbeMs map[string]int64
	tickCount   int64
	lastRunAt   int64
	lastError   string
	lastSummary QuotaProbeSummary
}

// NewQuotaProbeScheduler 创建未启动的账号额度后台探测调度器。
func NewQuotaProbeScheduler(opts QuotaProbeOptions) *QuotaProbeScheduler {
	interval := opts.Interval
	if interval <= 0 {
		interval = DefaultQuotaProbeInterval
	} else if interval < MinQuotaProbeInterval {
		interval = MinQuotaProbeInterval
	}
	startDelay := DefaultQuotaProbeStartDelay
	if opts.StartDelay != nil {
		if *opts.StartDelay >= 0 {
			startDelay = *opts.StartDelay
		}
	}
	batchSize := opts.BatchSize
	if batchSize <= 0 {
		batchSize = DefaultQuotaProbeBatch
	}
	cooldown := opts.Cooldown
	if cooldown <= 0 {
		cooldown = DefaultQuotaProbeCooldown
	}
	ahead := opts.Ahead
	if ahead <= 0 {
		ahead = DefaultQuotaProbeAheadWindow
	}
	staleAge := opts.StaleAge
	if staleAge <= 0 {
		staleAge = DefaultQuotaProbeStaleAge
	}
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	return &QuotaProbeScheduler{
		interval:    interval,
		startDelay:  startDelay,
		batchSize:   batchSize,
		cooldownMs:  cooldown.Milliseconds(),
		aheadMs:     ahead.Milliseconds(),
		staleAgeMs:  staleAge.Milliseconds(),
		source:      opts.Source,
		port:        opts.Port,
		now:         nowFn,
		testTickCh:  opts.testTickCh,
		lastProbeMs: make(map[string]int64),
	}
}

// Start 幂等启动后台定时探测协程。
func (s *QuotaProbeScheduler) Start(ctx context.Context) {
	if ctx == nil {
		ctx = context.Background()
	}
	s.mu.Lock()
	if s.running {
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

func (s *QuotaProbeScheduler) loop(ctx context.Context, doneCh chan struct{}) {
	defer func() {
		close(doneCh)
		s.mu.Lock()
		s.running = false
		s.cancel = nil
		s.doneCh = nil
		s.mu.Unlock()
	}()

	if s.testTickCh == nil {
		startTimer := time.NewTimer(s.startDelay)
		select {
		case <-ctx.Done():
			startTimer.Stop()
			return
		case <-startTimer.C:
			_, _ = s.Tick(ctx)
		}
	}

	var ticker *time.Ticker
	tickCh := s.testTickCh
	if tickCh == nil {
		ticker = time.NewTicker(s.interval)
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
			_, _ = s.Tick(ctx)
		}
	}
}

type probeCandidate struct {
	account QuotaAccount
	urgency int
}

// Tick 执行单轮非重叠的账号额度候选排序与受控批探测。
func (s *QuotaProbeScheduler) Tick(ctx context.Context) (QuotaProbeSummary, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	s.mu.Lock()
	if s.ticking {
		last := s.lastSummary
		s.mu.Unlock()
		return last, nil
	}
	if s.source == nil || s.port == nil {
		s.mu.Unlock()
		return QuotaProbeSummary{}, nil
	}
	s.ticking = true
	s.mu.Unlock()

	var summary QuotaProbeSummary
	var tickErr error
	defer func() {
		s.mu.Lock()
		s.ticking = false
		s.tickCount++
		s.lastRunAt = s.now().UnixMilli()
		if tickErr != nil {
			s.lastError = tickErr.Error()
		} else {
			s.lastError = ""
			s.lastSummary = summary
		}
		s.mu.Unlock()
	}()

	accounts, err := s.source.ListQuotaAccounts(ctx)
	if err != nil {
		tickErr = err
		return summary, err
	}

	nowMs := s.now().UnixMilli()
	summary.At = nowMs

	s.mu.Lock()
	candidates := make([]probeCandidate, 0, len(accounts))
	for _, acc := range accounts {
		if acc.APIKeyMode {
			continue
		}
		provider := strings.ToLower(strings.TrimSpace(acc.Provider))
		ref := strings.TrimSpace(acc.AccountRef)
		if provider == "" || ref == "" || !s.port.SupportsProvider(provider) {
			continue
		}
		if lastAt := s.lastProbeMs[ref]; lastAt > 0 && nowMs-lastAt < s.cooldownMs {
			continue
		}
		urgency := scoreQuotaUrgency(acc.Snapshot, nowMs, s.aheadMs, s.staleAgeMs)
		if urgency > 0 {
			candidates = append(candidates, probeCandidate{
				account: QuotaAccount{
					Provider:   provider,
					AccountRef: ref,
					APIKeyMode: acc.APIKeyMode,
					Snapshot:   acc.Snapshot,
				},
				urgency: urgency,
			})
		}
	}
	s.mu.Unlock()

	sort.SliceStable(candidates, func(i, j int) bool {
		return candidates[i].urgency > candidates[j].urgency
	})
	summary.Candidates = len(candidates)
	limit := s.batchSize
	if len(candidates) < limit {
		limit = len(candidates)
	}
	batch := candidates[:limit]

	for _, item := range batch {
		if ctx.Err() != nil {
			break
		}
		s.mu.Lock()
		s.lastProbeMs[item.account.AccountRef] = nowMs
		s.mu.Unlock()

		if err := s.port.ProbeAccountQuota(ctx, item.account); err != nil {
			summary.Failed++
		} else {
			summary.Probed++
		}
	}
	return summary, nil
}

func scoreQuotaUrgency(snapshot *QuotaSnapshot, nowMs, aheadMs, staleAgeMs int64) int {
	if snapshot == nil {
		return 1
	}
	urgency := 0
	hasConsumption := false
	hasUnknown := len(snapshot.Entries) == 0

	for _, entry := range snapshot.Entries {
		if entry.RemainingPct == nil {
			hasUnknown = true
		} else if *entry.RemainingPct < 100.0 {
			hasConsumption = true
		}
		if (entry.RemainingPct == nil || *entry.RemainingPct <= DefaultQuotaNearResetPct) && entry.ResetAtMs > 0 {
			if nowMs >= entry.ResetAtMs-aheadMs {
				if urgency < 10 {
					urgency = 10
				}
			}
		}
	}
	if urgency == 0 && nowMs-snapshot.CapturedAtMs > staleAgeMs {
		if hasConsumption || hasUnknown {
			urgency = 2
		}
	}
	return urgency
}

// State 返回并发安全的额度探测调度状态快照。
func (s *QuotaProbeScheduler) State() QuotaProbeState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return QuotaProbeState{
		Running:     s.running,
		Ticking:     s.ticking,
		Enabled:     s.source != nil && s.port != nil,
		IntervalMs:  s.interval.Milliseconds(),
		BatchSize:   s.batchSize,
		TickCount:   s.tickCount,
		LastRunAt:   s.lastRunAt,
		LastError:   s.lastError,
		LastSummary: s.lastSummary,
	}
}

// Stop 通知后台探测协程停止并等待退出。
func (s *QuotaProbeScheduler) Stop() {
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

// Close 实现 io.Closer，清理额度探测协程。
func (s *QuotaProbeScheduler) Close() error {
	s.Stop()
	return nil
}
