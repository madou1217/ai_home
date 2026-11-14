package tokenrefreshdaemon

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// DefaultInterval 是主动检查并续期即将到期 OAuth 凭据的默认周期（10 分钟，与原 Node 守护一致）。
	DefaultInterval = 10 * time.Minute
	// DefaultRefreshSkew 是临近过期的提前刷新窗口（30 分钟，至少覆盖多个调度周期）。
	DefaultRefreshSkew = 30 * time.Minute
	// DefaultConcurrency 限制每轮主动续期对上游 OAuth 端点的并发上限。
	DefaultConcurrency = 4
	// DefaultPerAccountTimeout 限制单个账号一次刷新请求的最长等待时间。
	DefaultPerAccountTimeout = 45 * time.Second
	// DefaultSuppressionRetryDelay 在 Refresh Token 明确失效后抑制重复撞击的冷却时间（24 小时）。
	DefaultSuppressionRetryDelay = 24 * time.Hour
)

var (
	// ErrMissingDependencies 表示尚未配置账号存储或凭据刷新器。
	ErrMissingDependencies = errors.New("token refresh daemon missing store or refresher")
)

// CredentialRefresher 抽象凭据候选检查与单飞 CAS 强刷能力（由 *accountcredentials.Resolver 实现）。
type CredentialRefresher interface {
	InspectRefreshCandidate(ctx context.Context, accountRef accountcore.AccountRef) (accountcredentials.RefreshCandidate, error)
	ForceRefreshCredentialBinding(ctx context.Context, accountRef accountcore.AccountRef) (accountapp.CredentialBinding, error)
}

// Options 配置 OAuth 后台续期守护进程参数与外部依赖端口。
type Options struct {
	Enabled                   *bool
	DelegateCredentialRefresh bool
	Interval                  time.Duration
	StartDelay                *time.Duration
	Skew                      time.Duration
	Concurrency               int
	PerAccountTimeout         time.Duration
	SuppressionRetryDelay     time.Duration
	AIHomeDir                 string
	Store                     AccountStore
	Refresher                 CredentialRefresher
	Runtime                   AccountRuntimeNotifier
	Now                       func() time.Time

	testTickCh <-chan time.Time
}

// ProviderStats 汇总单个 Provider 的累计续期与失败计数。
type ProviderStats struct {
	Scanned     int64  `json:"scanned"`
	Due         int64  `json:"due"`
	Refreshed   int64  `json:"refreshed"`
	Skipped     int64  `json:"skipped"`
	Suppressed  int64  `json:"suppressed"`
	Invalidated int64  `json:"invalidated"`
	Errors      int64  `json:"errors"`
	LastError   string `json:"lastError,omitempty"`
}

// DaemonState 暴露 OAuth 主动续期守护进程的可观测状态快照。
type DaemonState struct {
	Running          bool                     `json:"running"`
	Enabled          bool                     `json:"enabled"`
	Delegated        bool                     `json:"delegated"`
	IntervalMs       int64                    `json:"intervalMs"`
	SkewMs           int64                    `json:"skewMs"`
	TickCount        int64                    `json:"tickCount"`
	LastTickAt       int64                    `json:"lastTickAt"`
	LastDurationMs   int64                    `json:"lastDurationMs"`
	RefreshedCount   int64                    `json:"refreshedCount"`
	SkippedCount     int64                    `json:"skippedCount"`
	SuppressedCount  int64                    `json:"suppressedCount"`
	InvalidatedCount int64                    `json:"invalidatedCount"`
	ErrorCount       int64                    `json:"errorCount"`
	ActiveSuppressed int                      `json:"activeSuppressed"`
	LastError        string                   `json:"lastError,omitempty"`
	Providers        map[string]ProviderStats `json:"providers,omitempty"`
}

// TickSummary 描述单次 Tick 或手动 Trigger 的执行汇总结果。
type TickSummary struct {
	OK          bool   `json:"ok"`
	Provider    string `json:"provider,omitempty"`
	Delegated   bool   `json:"delegated,omitempty"`
	SkippedAll  bool   `json:"skipped,omitempty"`
	Reason      string `json:"reason,omitempty"`
	Scanned     int    `json:"scanned"`
	Due         int    `json:"due"`
	Refreshed   int    `json:"refreshed"`
	Skipped     int    `json:"skippedCount"`
	Suppressed  int    `json:"suppressed"`
	Invalidated int    `json:"invalidated"`
	Errors      int    `json:"errors"`
	DurationMs  int64  `json:"durationMs"`
}

// Daemon 周期扫描启用中的 OAuth 账号并主动续期即将过期的 Access Token。
type Daemon struct {
	enabled                   bool
	delegateCredentialRefresh bool
	interval                  time.Duration
	startDelay                time.Duration
	skew                      time.Duration
	concurrency               int
	perAccountTimeout         time.Duration
	suppressionRetryDelay     time.Duration
	store                     AccountStore
	refresher                 CredentialRefresher
	runtime                   AccountRuntimeNotifier
	now                       func() time.Time
	suppressions              *suppressionStore
	testTickCh                <-chan time.Time
	runGate                   chan struct{}

	mu               sync.Mutex
	running          bool
	cancel           context.CancelFunc
	doneCh           chan struct{}
	tickCount        int64
	lastTickAt       int64
	lastDurationMs   int64
	refreshedCount   int64
	skippedCount     int64
	suppressedCount  int64
	invalidatedCount int64
	errorCount       int64
	lastError        string
	providers        map[string]ProviderStats
}

// New 创建未启动的 OAuth 后台续期守护进程实例。
func New(opts Options) *Daemon {
	enabled := true
	if opts.Enabled != nil {
		enabled = *opts.Enabled
	}
	interval := opts.Interval
	if interval <= 0 {
		interval = DefaultInterval
	}
	startDelay := time.Duration(0)
	if opts.StartDelay != nil && *opts.StartDelay >= 0 {
		startDelay = *opts.StartDelay
	}
	skew := opts.Skew
	if skew <= 0 {
		skew = DefaultRefreshSkew
		if minSkew := 2 * interval; minSkew > skew {
			skew = minSkew
		}
	}
	concurrency := opts.Concurrency
	if concurrency <= 0 {
		concurrency = DefaultConcurrency
	}
	perAccountTimeout := opts.PerAccountTimeout
	if perAccountTimeout <= 0 {
		perAccountTimeout = DefaultPerAccountTimeout
	}
	suppressionDelay := opts.SuppressionRetryDelay
	if suppressionDelay <= 0 {
		suppressionDelay = DefaultSuppressionRetryDelay
	}
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = time.Now
	}

	return &Daemon{
		enabled:                   enabled,
		delegateCredentialRefresh: opts.DelegateCredentialRefresh,
		interval:                  interval,
		startDelay:                startDelay,
		skew:                      skew,
		concurrency:               concurrency,
		perAccountTimeout:         perAccountTimeout,
		suppressionRetryDelay:     suppressionDelay,
		store:                     opts.Store,
		refresher:                 opts.Refresher,
		runtime:                   opts.Runtime,
		now:                       nowFn,
		suppressions:              newSuppressionStore(opts.AIHomeDir, nowFn()),
		testTickCh:                opts.testTickCh,
		runGate:                   make(chan struct{}, 1),
		providers:                 make(map[string]ProviderStats),
	}
}

// Start 幂等启动后台定时续期循环；若禁用、委托给宿主或缺少依赖则安全空转返回。
func (d *Daemon) Start(ctx context.Context) {
	if d == nil {
		return
	}
	if !d.enabled || d.delegateCredentialRefresh || d.store == nil || d.refresher == nil {
		return
	}
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

func (d *Daemon) loop(ctx context.Context, doneCh chan struct{}) {
	defer func() {
		close(doneCh)
		d.mu.Lock()
		d.running = false
		d.cancel = nil
		d.doneCh = nil
		d.mu.Unlock()
	}()

	if d.testTickCh == nil {
		if d.startDelay <= 0 {
			_, _ = d.tryScheduledTick(ctx)
		} else {
			startTimer := time.NewTimer(d.startDelay)
			select {
			case <-ctx.Done():
				startTimer.Stop()
				return
			case <-startTimer.C:
				_, _ = d.tryScheduledTick(ctx)
			}
		}
	}

	var ticker *time.Ticker
	tickCh := d.testTickCh
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
			_, _ = d.tryScheduledTick(ctx)
		}
	}
}

func (d *Daemon) tryScheduledTick(ctx context.Context) (TickSummary, error) {
	select {
	case d.runGate <- struct{}{}:
		defer func() { <-d.runGate }()
		return d.executeCycle(ctx, "")
	default:
		return TickSummary{OK: true, SkippedAll: true, Reason: "tick_in_progress"}, nil
	}
}

// Tick 执行一轮全量 OAuth 过期扫描与续期。
func (d *Daemon) Tick(ctx context.Context) (TickSummary, error) {
	return d.Trigger(ctx, "")
}

// Trigger 手动触发一轮续期扫描，可选按规范 provider ID 过滤。
func (d *Daemon) Trigger(ctx context.Context, provider string) (TickSummary, error) {
	if d == nil {
		return TickSummary{}, ErrMissingDependencies
	}
	if ctx == nil {
		ctx = context.Background()
	}
	providerFilter := strings.ToLower(strings.TrimSpace(provider))
	if !d.enabled {
		return TickSummary{OK: true, Provider: providerFilter, SkippedAll: true, Reason: "disabled"}, nil
	}
	if d.delegateCredentialRefresh {
		return TickSummary{OK: true, Provider: providerFilter, Delegated: true, SkippedAll: true, Reason: "delegated_to_host"}, nil
	}
	if d.store == nil || d.refresher == nil {
		return TickSummary{}, ErrMissingDependencies
	}

	select {
	case d.runGate <- struct{}{}:
		defer func() { <-d.runGate }()
	case <-ctx.Done():
		return TickSummary{}, ctx.Err()
	}
	return d.executeCycle(ctx, providerFilter)
}

type refreshJob struct {
	accountRef          accountcore.AccountRef
	providerID          string
	signals             credentialSignals
	credentialUpdatedMS int64
}

type refreshOutcome struct {
	job         refreshJob
	refreshed   bool
	skipped     bool
	suppressed  bool
	invalidated bool
	err         error
}

type cycleStats struct {
	summary     TickSummary
	providers   map[string]ProviderStats
	lastErrText string
}

func (d *Daemon) executeCycle(ctx context.Context, providerFilter string) (TickSummary, error) {
	startTime := d.now()
	now := startTime.UTC()

	stats := cycleStats{
		summary: TickSummary{
			OK:       true,
			Provider: providerFilter,
		},
		providers: make(map[string]ProviderStats),
	}

	overviews, err := d.listAllOverviews(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return TickSummary{}, ctx.Err()
		}
		stats.summary.OK = false
		stats.summary.Errors = 1
		stats.summary.DurationMs = d.now().Sub(startTime).Milliseconds()
		stats.lastErrText = sanitizeReason(err.Error(), 240)
		d.recordCycle(now, stats)
		return stats.summary, err
	}

	if providerFilter == "" {
		activeRefs := make(map[string]struct{}, len(overviews))
		for _, overview := range overviews {
			activeRefs[overview.Account().Ref().String()] = struct{}{}
		}
		d.suppressions.PruneMissing(activeRefs, now)
	}

	jobs := make([]refreshJob, 0, len(overviews))
	for _, overview := range overviews {
		if err := ctx.Err(); err != nil {
			return TickSummary{}, err
		}
		acc := overview.Account()
		providerID := strings.ToLower(strings.TrimSpace(acc.ProviderID()))
		if providerFilter != "" && providerID != providerFilter {
			continue
		}
		stats.summary.Scanned++
		pStats := stats.providers[providerID]
		pStats.Scanned++

		if !acc.Enabled() || !overview.HasCredential() {
			stats.summary.Skipped++
			pStats.Skipped++
			stats.providers[providerID] = pStats
			continue
		}

		apiKey, apiKeyErr := d.store.IsAPIKeyAccount(ctx, acc.Ref())
		if apiKeyErr != nil {
			if ctx.Err() != nil {
				return TickSummary{}, ctx.Err()
			}
			stats.summary.Errors++
			pStats.Errors++
			errText := sanitizeReason(apiKeyErr.Error(), 240)
			pStats.LastError = errText
			stats.lastErrText = errText
			stats.providers[providerID] = pStats
			continue
		}
		if apiKey {
			stats.summary.Skipped++
			pStats.Skipped++
			stats.providers[providerID] = pStats
			continue
		}

		candidate, inspectErr := d.refresher.InspectRefreshCandidate(ctx, acc.Ref())
		if inspectErr != nil {
			if ctx.Err() != nil {
				return TickSummary{}, ctx.Err()
			}
			if isSkippedRefreshError(inspectErr) {
				stats.summary.Skipped++
				pStats.Skipped++
				stats.providers[providerID] = pStats
				continue
			}
			stats.summary.Errors++
			pStats.Errors++
			errText := sanitizeReason(inspectErr.Error(), 240)
			pStats.LastError = errText
			stats.lastErrText = errText
			stats.providers[providerID] = pStats
			continue
		}

		if !candidate.Refreshable || candidate.Delegated {
			stats.summary.Skipped++
			pStats.Skipped++
			stats.providers[providerID] = pStats
			continue
		}

		if !isCredentialDue(candidate.ExpiresAt, now, d.skew) {
			stats.summary.Skipped++
			pStats.Skipped++
			stats.providers[providerID] = pStats
			continue
		}

		stats.summary.Due++
		pStats.Due++

		signals := inspectCredentialSignals(candidate.Snapshot.Credential())
		updatedMS := candidate.Snapshot.UpdatedAt().UnixMilli()
		if d.suppressions.IsSuppressed(acc.Ref().String(), signals.refreshTokenDigest, updatedMS, now) {
			stats.summary.Suppressed++
			pStats.Suppressed++
			stats.providers[providerID] = pStats
			continue
		}

		stats.providers[providerID] = pStats
		jobs = append(jobs, refreshJob{
			accountRef:          acc.Ref(),
			providerID:          providerID,
			signals:             signals,
			credentialUpdatedMS: updatedMS,
		})
	}

	if len(jobs) > 0 {
		outcomes := d.runJobs(ctx, jobs)
		finishNow := d.now().UTC()
		for _, outcome := range outcomes {
			if ctx.Err() != nil && (errors.Is(outcome.err, context.Canceled) || errors.Is(outcome.err, context.DeadlineExceeded)) {
				continue
			}
			pStats := stats.providers[outcome.job.providerID]
			switch {
			case outcome.refreshed:
				stats.summary.Refreshed++
				pStats.Refreshed++
				d.suppressions.Clear(outcome.job.accountRef.String(), finishNow)
				_, _ = clearAccountAuthInvalid(ctx, d.store, d.runtime, outcome.job.accountRef, finishNow)
			case outcome.skipped:
				stats.summary.Skipped++
				pStats.Skipped++
			case outcome.err != nil:
				stats.summary.Errors++
				pStats.Errors++
				errText := sanitizeReason(outcome.err.Error(), 240)
				pStats.LastError = errText
				stats.lastErrText = errText

				if isPermanentInvalidRefreshError(outcome.err) {
					d.suppressions.Remember(
						outcome.job.accountRef.String(),
						outcome.job.providerID,
						outcome.job.signals.refreshTokenDigest,
						outcome.job.credentialUpdatedMS,
						errText,
						d.suppressionRetryDelay,
						finishNow,
					)
					stats.summary.Suppressed++
					pStats.Suppressed++

					if !outcome.job.signals.hasAccessToken {
						marked, markErr := markAccountAuthInvalid(
							ctx,
							d.store,
							d.runtime,
							outcome.job.accountRef,
							fmt.Sprintf("token_refresh_%s", errText),
							finishNow,
						)
						if markErr == nil && marked {
							stats.summary.Invalidated++
							pStats.Invalidated++
						}
					}
				}
			}
			stats.providers[outcome.job.providerID] = pStats
		}
	}

	if err := ctx.Err(); err != nil {
		return TickSummary{}, err
	}
	durationMs := d.now().Sub(startTime).Milliseconds()
	if durationMs < 0 {
		durationMs = 0
	}
	stats.summary.DurationMs = durationMs
	d.recordCycle(now, stats)
	return stats.summary, nil
}

func (d *Daemon) runJobs(ctx context.Context, jobs []refreshJob) []refreshOutcome {
	outcomes := make([]refreshOutcome, len(jobs))
	workerCount := d.concurrency
	if workerCount > len(jobs) {
		workerCount = len(jobs)
	}
	if workerCount < 1 {
		workerCount = 1
	}

	indexCh := make(chan int, len(jobs))
	for i := range jobs {
		indexCh <- i
	}
	close(indexCh)

	var wg sync.WaitGroup
	wg.Add(workerCount)
	for w := 0; w < workerCount; w++ {
		go func() {
			defer wg.Done()
			for idx := range indexCh {
				job := jobs[idx]
				if ctx.Err() != nil {
					outcomes[idx] = refreshOutcome{job: job, err: ctx.Err()}
					continue
				}
				jobCtx, cancel := context.WithTimeout(ctx, d.perAccountTimeout)
				_, err := d.refresher.ForceRefreshCredentialBinding(jobCtx, job.accountRef)
				cancel()
				switch {
				case err == nil:
					outcomes[idx] = refreshOutcome{job: job, refreshed: true}
				case isSkippedRefreshError(err):
					outcomes[idx] = refreshOutcome{job: job, skipped: true}
				default:
					outcomes[idx] = refreshOutcome{job: job, err: err}
				}
			}
		}()
	}
	wg.Wait()
	return outcomes
}

func (d *Daemon) listAllOverviews(ctx context.Context) ([]accountapp.AccountOverview, error) {
	var all []accountapp.AccountOverview
	var afterRef accountcore.AccountRef
	for {
		query, err := accountapp.NewOverviewQuery(afterRef, accountapp.MaxOverviewLimit)
		if err != nil {
			return nil, err
		}
		page, err := d.store.ListAccountOverviews(ctx, query)
		if err != nil {
			return nil, err
		}
		all = append(all, page...)
		if len(page) < accountapp.MaxOverviewLimit {
			break
		}
		afterRef = page[len(page)-1].Account().Ref()
	}
	sort.Slice(all, func(i, j int) bool {
		return all[i].Account().Ref().String() < all[j].Account().Ref().String()
	})
	return all, nil
}

func (d *Daemon) recordCycle(now time.Time, stats cycleStats) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.tickCount++
	d.lastTickAt = now.UnixMilli()
	d.lastDurationMs = stats.summary.DurationMs
	d.refreshedCount += int64(stats.summary.Refreshed)
	d.skippedCount += int64(stats.summary.Skipped)
	d.suppressedCount += int64(stats.summary.Suppressed)
	d.invalidatedCount += int64(stats.summary.Invalidated)
	d.errorCount += int64(stats.summary.Errors)
	if stats.lastErrText != "" {
		d.lastError = stats.lastErrText
	} else if stats.summary.Errors == 0 {
		d.lastError = ""
	}
	for providerID, delta := range stats.providers {
		prev := d.providers[providerID]
		prev.Scanned += delta.Scanned
		prev.Due += delta.Due
		prev.Refreshed += delta.Refreshed
		prev.Skipped += delta.Skipped
		prev.Suppressed += delta.Suppressed
		prev.Invalidated += delta.Invalidated
		prev.Errors += delta.Errors
		if delta.LastError != "" {
			prev.LastError = delta.LastError
		} else if delta.Errors == 0 && delta.Refreshed > 0 {
			prev.LastError = ""
		}
		d.providers[providerID] = prev
	}
}

// State 返回当前 OAuth 续期守护进程的线程安全状态快照。
func (d *Daemon) State() DaemonState {
	if d == nil {
		return DaemonState{}
	}
	now := d.now().UTC()
	activeSuppressed := d.suppressions.Count(now)

	d.mu.Lock()
	defer d.mu.Unlock()
	providersCopy := make(map[string]ProviderStats, len(d.providers))
	for k, v := range d.providers {
		providersCopy[k] = v
	}
	return DaemonState{
		Running:          d.running,
		Enabled:          d.enabled,
		Delegated:        d.delegateCredentialRefresh,
		IntervalMs:       d.interval.Milliseconds(),
		SkewMs:           d.skew.Milliseconds(),
		TickCount:        d.tickCount,
		LastTickAt:       d.lastTickAt,
		LastDurationMs:   d.lastDurationMs,
		RefreshedCount:   d.refreshedCount,
		SkippedCount:     d.skippedCount,
		SuppressedCount:  d.suppressedCount,
		InvalidatedCount: d.invalidatedCount,
		ErrorCount:       d.errorCount,
		ActiveSuppressed: activeSuppressed,
		LastError:        d.lastError,
		Providers:        providersCopy,
	}
}

// Status 是 State 的等价别名，匹配守护进程状态查询合同。
func (d *Daemon) Status() DaemonState {
	return d.State()
}

// Stop 优雅停止后台协程并等待其退出。
func (d *Daemon) Stop() {
	if d == nil {
		return
	}
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

// Close 实现 io.Closer，安全停止后台协程。
func (d *Daemon) Close() error {
	d.Stop()
	return nil
}

func isCredentialDue(expiresAt time.Time, now time.Time, skew time.Duration) bool {
	if expiresAt.IsZero() {
		return true
	}
	return !expiresAt.After(now.Add(skew))
}

func isSkippedRefreshError(err error) bool {
	return errors.Is(err, accountcredentials.ErrCredentialNotRefreshable) ||
		errors.Is(err, accountapp.ErrCredentialNotFound) ||
		errors.Is(err, accountcredentials.ErrRefreshStrategyNotFound)
}

func isPermanentInvalidRefreshError(err error) bool {
	return errors.Is(err, accountcredentials.ErrReauthenticationRequired) ||
		errors.Is(err, accountapp.ErrReauthenticationIdentityMismatch)
}
