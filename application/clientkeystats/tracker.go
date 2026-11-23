// Package clientkeystats 统计每个客户端 API Key 的请求、尝试、token 与在途并发。
//
// 语义（与限流设计一致）：
//   - requests：一个已鉴权请求 +1；重试/换号不重复计。
//   - attempts：每次真实上游调用 +1。
//   - successes/failures：尝试级终态，由运行态终态汇点记录。
//   - tokens：由同一个 usage 记账事件旁路累加，与 usage_ledger 同源。
//   - in-flight：按（key, provider, model, account）的 gauge，defer 保证恰好一次减一。
//
// 内存里保留当前分钟与滚动速率窗口；每 5s 把已关闭的分钟桶落库。
package clientkeystats

import (
	"context"
	"errors"
	"sync"
	"time"

	coreclientkeys "github.com/madou1217/ai_home/core/clientkeys"
	"github.com/madou1217/ai_home/core/concurrency"
	"github.com/madou1217/ai_home/core/inference"
)

// ErrUnavailable 表示统计器缺少持久化端口。
var ErrUnavailable = errors.New("客户端 Key 统计器不可用")

// Store 是统计持久化端口。
type Store interface {
	UpsertClientKeyStats(
		ctx context.Context,
		requests []coreclientkeys.RequestBucket,
		attempts []coreclientkeys.AttemptBucket,
	) error
	QueryClientKeyAttempts(ctx context.Context, query coreclientkeys.StatsQuery) ([]coreclientkeys.AttemptBucket, error)
	QueryClientKeyRequests(ctx context.Context, query coreclientkeys.StatsQuery) ([]coreclientkeys.RequestBucket, error)
}

// Outcome 是尝试终态。
type Outcome string

const (
	OutcomeSuccess Outcome = "success"
	OutcomeFailure Outcome = "failure"
)

const (
	minuteMS     = int64(60_000)
	rateBucketMS = int64(1_000)
	rateSlots    = 300 // 5 分钟，1s 粒度：滚动 60s 窗口误差不超过 1s
	defaultFlush = 5 * time.Second
	// rateWindowMS 是 RPM/TPM 的滚动窗口。
	rateWindowMS = int64(60_000)
	// dailyCacheTTL 是每日持久桶求和的缓存时长；期间只叠加未落库的内存桶。
	dailyCacheTTL = time.Second
)

// Options 是 Tracker 的构造参数。
type Options struct {
	Store Store
	Clock func() time.Time
}

// Tracker 汇总内存计数并落库。
type Tracker struct {
	store Store
	clock func() time.Time

	mu           sync.Mutex
	requests     map[requestKey]*requestCounts
	attempts     map[attemptKey]*attemptCounts
	live         map[liveKey]int64
	rates        map[string]*rateRing
	accountRates map[string]*rateRing
	daily        map[string]dailyCacheEntry
	sessionUsage map[string]*coreclientkeys.RemoteSessionUsage
	flushAt      time.Time
}

// SessionUsageStore is the optional remote-session usage sink. Stores that do
// not implement it keep account-level stats only.
type SessionUsageStore interface {
	UpsertRemoteSessionUsage(ctx context.Context, entries []coreclientkeys.RemoteSessionUsage) error
	QueryRemoteSessionUsage(ctx context.Context, sessionID string) (coreclientkeys.RemoteSessionUsage, bool, error)
}

// dailyCacheEntry 缓存某 Key 自 UTC 零点起已落库的 token 数；未落库的内存桶每次另加。
type dailyCacheEntry struct {
	dayStartMS int64
	fetchedAt  time.Time
	tokens     int64
}

type requestKey struct {
	minute  int64
	keyID   string
	surface string
}

type requestCounts struct {
	requests int64
	aborted  int64
}

type attemptKey struct {
	minute   int64
	keyID    string
	provider string
	model    string
	account  string
}

type attemptCounts struct {
	attempts     int64
	successes    int64
	failures     int64
	aborted      int64
	inputTokens  int64
	outputTokens int64
	cachedInput  int64
	cacheWrite   int64
	reasoning    int64
	totalTokens  int64
}

type liveKey struct {
	keyID    string
	provider string
	model    string
	account  string
}

type rateRing struct {
	slots [rateSlots]rateBucket
}

type rateBucket struct {
	startMS  int64
	requests int64 // 客户端请求（鉴权阶段计入）
	admitted int64 // 已准入的真实上游调用
	tokens   int64
}

// NewTracker 创建统计器。
func NewTracker(options Options) (*Tracker, error) {
	if options.Store == nil {
		return nil, ErrUnavailable
	}
	clock := options.Clock
	if clock == nil {
		clock = time.Now
	}
	tracker := &Tracker{
		store:        options.Store,
		clock:        clock,
		requests:     map[requestKey]*requestCounts{},
		attempts:     map[attemptKey]*attemptCounts{},
		live:         map[liveKey]int64{},
		rates:        map[string]*rateRing{},
		accountRates: map[string]*rateRing{},
		daily:        map[string]dailyCacheEntry{},
		sessionUsage: map[string]*coreclientkeys.RemoteSessionUsage{},
	}
	tracker.flushAt = clock()
	return tracker, nil
}

// RequestScope 代表一个已鉴权请求。
type RequestScope struct {
	tracker *Tracker
	keyID   string
	surface string
	once    sync.Once
}

// BeginRequest 记录一次请求并返回作用域。
func (tracker *Tracker) BeginRequest(identity coreclientkeys.Identity, surface string) *RequestScope {
	if tracker == nil || !identity.IsValid() {
		return nil
	}
	now := tracker.clock()
	minute := now.UnixMilli() - now.UnixMilli()%minuteMS
	tracker.mu.Lock()
	key := requestKey{minute: minute, keyID: identity.KeyID, surface: surface}
	counts := tracker.requests[key]
	if counts == nil {
		counts = &requestCounts{}
		tracker.requests[key] = counts
	}
	counts.requests++
	tracker.rateAddLocked(tracker.rates, identity.KeyID, now, 1, 0, 0)
	tracker.live[liveKey{keyID: identity.KeyID}]++
	tracker.mu.Unlock()
	return &RequestScope{tracker: tracker, keyID: identity.KeyID, surface: surface}
}

// Finish 结束请求；aborted 表示客户端中断或未产生终态。
func (scope *RequestScope) Finish(aborted bool) {
	if scope == nil || scope.tracker == nil {
		return
	}
	scope.once.Do(func() {
		now := scope.tracker.clock()
		minute := now.UnixMilli() - now.UnixMilli()%minuteMS
		scope.tracker.mu.Lock()
		liveKeyValue := liveKey{keyID: scope.keyID}
		if scope.tracker.live[liveKeyValue] > 1 {
			scope.tracker.live[liveKeyValue]--
		} else {
			delete(scope.tracker.live, liveKeyValue)
		}
		if aborted {
			key := requestKey{minute: minute, keyID: scope.keyID, surface: scope.surface}
			counts := scope.tracker.requests[key]
			if counts == nil {
				counts = &requestCounts{}
				scope.tracker.requests[key] = counts
			}
			counts.aborted++
		}
		scope.tracker.mu.Unlock()
	})
}

// AttemptScope 代表一次真实上游调用。
type AttemptScope struct {
	tracker  *Tracker
	keyID    string
	provider string
	model    string
	account  string
	once     sync.Once
}

// BeginAttempt 在请求作用域下记录一次上游尝试。
func (scope *RequestScope) BeginAttempt(provider, accountRef, model string) *AttemptScope {
	if scope == nil || scope.tracker == nil {
		return nil
	}
	return scope.tracker.beginAttempt(scope.keyID, provider, accountRef, model)
}

// BeginAttempt 在缺少请求作用域时（例如内部任务）按上下文身份记录尝试。
func (tracker *Tracker) BeginAttempt(
	ctx context.Context,
	provider string,
	accountRef string,
	model string,
) *AttemptScope {
	if tracker == nil {
		return nil
	}
	identity, ok := coreclientkeys.IdentityFromContext(ctx)
	if !ok {
		identity = coreclientkeys.MasterIdentity()
	}
	return tracker.beginAttempt(identity.KeyID, provider, accountRef, model)
}

func (tracker *Tracker) beginAttempt(keyID, provider, accountRef, model string) *AttemptScope {
	if tracker == nil || keyID == "" {
		return nil
	}
	now := tracker.clock()
	minute := now.UnixMilli() - now.UnixMilli()%minuteMS
	tracker.mu.Lock()
	key := attemptKey{minute: minute, keyID: keyID, provider: provider, model: model, account: accountRef}
	counts := tracker.attempts[key]
	if counts == nil {
		counts = &attemptCounts{}
		tracker.attempts[key] = counts
	}
	tracker.live[liveKey{keyID: keyID, provider: provider, model: model, account: accountRef}]++
	tracker.mu.Unlock()
	return &AttemptScope{tracker: tracker, keyID: keyID, provider: provider, model: model, account: accountRef}
}

// Finish 结束一次尝试；aborted 表示未得到明确终态（取消/断开）。
func (scope *AttemptScope) Finish(aborted bool) {
	if scope == nil || scope.tracker == nil {
		return
	}
	scope.once.Do(func() {
		tracker := scope.tracker
		now := tracker.clock()
		minute := now.UnixMilli() - now.UnixMilli()%minuteMS
		tracker.mu.Lock()
		key := liveKey{keyID: scope.keyID, provider: scope.provider, model: scope.model, account: scope.account}
		if tracker.live[key] > 1 {
			tracker.live[key]--
		} else {
			delete(tracker.live, key)
		}
		if aborted {
			attemptKeyValue := attemptKey{minute: minute, keyID: scope.keyID, provider: scope.provider, model: scope.model, account: scope.account}
			counts := tracker.attempts[attemptKeyValue]
			if counts == nil {
				counts = &attemptCounts{}
				tracker.attempts[attemptKeyValue] = counts
			}
			counts.attempts++
			counts.aborted++
		}
		tracker.mu.Unlock()
	})
}

// RecordAttempt 记录尝试级成功/失败（由运行态终态汇点调用）。
func (tracker *Tracker) RecordAttempt(
	ctx context.Context,
	provider string,
	accountRef string,
	model string,
	outcome Outcome,
) {
	if tracker == nil {
		return
	}
	identity, ok := coreclientkeys.IdentityFromContext(ctx)
	if !ok {
		identity = coreclientkeys.MasterIdentity()
	}
	tracker.recordAttempt(identity.KeyID, provider, accountRef, model, outcome)
}

func (tracker *Tracker) recordAttempt(keyID, provider, accountRef, model string, outcome Outcome) {
	now := tracker.clock()
	minute := now.UnixMilli() - now.UnixMilli()%minuteMS
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	key := attemptKey{minute: minute, keyID: keyID, provider: provider, model: model, account: accountRef}
	counts := tracker.attempts[key]
	if counts == nil {
		counts = &attemptCounts{}
		tracker.attempts[key] = counts
	}
	counts.attempts++
	switch outcome {
	case OutcomeSuccess:
		counts.successes++
	case OutcomeFailure:
		counts.failures++
	}
}

// RecordAdmitted 记录一次被准入的真实上游调用；被拒绝的请求不消耗 RPM 名额。
func (tracker *Tracker) RecordAdmitted(keyID, accountRef string) {
	if tracker == nil {
		return
	}
	now := tracker.clock()
	tracker.mu.Lock()
	tracker.rateAddLocked(tracker.rates, keyID, now, 0, 1, 0)
	tracker.rateAddLocked(tracker.accountRates, accountRef, now, 0, 1, 0)
	tracker.mu.Unlock()
}

// RecordUsage 记录一次 token 用量（与 usage_ledger 同源）。
func (tracker *Tracker) RecordUsage(
	ctx context.Context,
	provider string,
	accountRef string,
	model string,
	usage inference.Usage,
) {
	if tracker == nil || !usage.IsValid() {
		return
	}
	identity, ok := coreclientkeys.IdentityFromContext(ctx)
	if !ok {
		identity = coreclientkeys.MasterIdentity()
	}
	now := tracker.clock()
	minute := now.UnixMilli() - now.UnixMilli()%minuteMS
	tracker.mu.Lock()
	key := attemptKey{minute: minute, keyID: identity.KeyID, provider: provider, model: model, account: accountRef}
	counts := tracker.attempts[key]
	if counts == nil {
		counts = &attemptCounts{}
		tracker.attempts[key] = counts
	}
	counts.inputTokens += saturating(usage.InputTokens())
	counts.outputTokens += saturating(usage.OutputTokens())
	counts.cachedInput += saturating(usage.CachedInputTokens())
	counts.cacheWrite += saturating(usage.CacheWriteInputTokens())
	counts.reasoning += saturating(usage.ReasoningTokens())
	counts.totalTokens += saturating(usage.TotalTokens())
	tracker.rateAddLocked(tracker.rates, identity.KeyID, now, 0, 0, saturating(usage.TotalTokens()))
	tracker.rateAddLocked(tracker.accountRates, accountRef, now, 0, 0, saturating(usage.TotalTokens()))
	if sessionID := RemoteSessionFromContext(ctx); sessionID != "" {
		entry := tracker.sessionUsage[sessionID]
		if entry == nil {
			entry = &coreclientkeys.RemoteSessionUsage{SessionID: sessionID}
			tracker.sessionUsage[sessionID] = entry
		}
		entry.InputTokens += saturating(usage.InputTokens())
		entry.OutputTokens += saturating(usage.OutputTokens())
		entry.CachedInputTokens += saturating(usage.CachedInputTokens())
		entry.CacheWriteInputTokens += saturating(usage.CacheWriteInputTokens())
		entry.ReasoningTokens += saturating(usage.ReasoningTokens())
		entry.TotalTokens += saturating(usage.TotalTokens())
		entry.UpdatedAtMS = now.UnixMilli()
	}
	tracker.mu.Unlock()
}

// Flush 把已关闭的分钟桶写入数据库。
func (tracker *Tracker) Flush(ctx context.Context) error {
	if tracker == nil || tracker.store == nil {
		return nil
	}
	now := tracker.clock()
	currentMinute := now.UnixMilli() - now.UnixMilli()%minuteMS
	tracker.mu.Lock()
	requestBuckets := make([]coreclientkeys.RequestBucket, 0, len(tracker.requests))
	for key, counts := range tracker.requests {
		if key.minute >= currentMinute {
			continue
		}
		requestBuckets = append(requestBuckets, coreclientkeys.RequestBucket{
			BucketMS: key.minute, KeyID: key.keyID, Surface: key.surface,
			Requests: counts.requests, Aborted: counts.aborted,
		})
		delete(tracker.requests, key)
	}
	attemptBuckets := make([]coreclientkeys.AttemptBucket, 0, len(tracker.attempts))
	for key, counts := range tracker.attempts {
		if key.minute >= currentMinute {
			continue
		}
		attemptBuckets = append(attemptBuckets, coreclientkeys.AttemptBucket{
			BucketMS: key.minute, KeyID: key.keyID, ProviderID: key.provider,
			ModelID: key.model, AccountRef: key.account,
			Attempts: counts.attempts, Successes: counts.successes,
			Failures: counts.failures, Aborted: counts.aborted,
			InputTokens: counts.inputTokens, OutputTokens: counts.outputTokens,
			CachedInputTokens: counts.cachedInput, CacheWriteInputTokens: counts.cacheWrite,
			ReasoningTokens: counts.reasoning, TotalTokens: counts.totalTokens,
		})
		delete(tracker.attempts, key)
	}
	sessionEntries := make([]coreclientkeys.RemoteSessionUsage, 0, len(tracker.sessionUsage))
	for sessionID, entry := range tracker.sessionUsage {
		sessionEntries = append(sessionEntries, *entry)
		delete(tracker.sessionUsage, sessionID)
	}
	tracker.mu.Unlock()
	if err := tracker.store.UpsertClientKeyStats(ctx, requestBuckets, attemptBuckets); err != nil {
		return err
	}
	if len(sessionEntries) == 0 {
		return nil
	}
	if sessionStore, ok := tracker.store.(SessionUsageStore); ok {
		return sessionStore.UpsertRemoteSessionUsage(ctx, sessionEntries)
	}
	return nil
}

// Start 运行刷盘循环直到 ctx 结束。
func (tracker *Tracker) Start(ctx context.Context) {
	if tracker == nil {
		return
	}
	ticker := time.NewTicker(defaultFlush)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			_ = tracker.Flush(context.Background())
			return
		case <-ticker.C:
			_ = tracker.Flush(ctx)
		}
	}
}

// LiveRow 是按 Key 聚合的实时行。
type LiveRow struct {
	KeyID    string
	InFlight int64
	RPM1m    float64
	RPM5m    float64
	TPM1m    float64
	TPM5m    float64
}

// Live 返回按 Key 聚合的实时并发与速率。
func (tracker *Tracker) Live() []LiveRow {
	if tracker == nil {
		return nil
	}
	now := tracker.clock()
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	inFlight := map[string]int64{}
	for key, count := range tracker.live {
		inFlight[key.keyID] += count
	}
	rows := make([]LiveRow, 0, len(inFlight)+len(tracker.rates))
	seen := map[string]bool{}
	for keyID, count := range inFlight {
		seen[keyID] = true
		row := LiveRow{KeyID: keyID, InFlight: count}
		row.RPM1m, row.RPM5m, row.TPM1m, row.TPM5m = tracker.ratesLocked(keyID, now)
		rows = append(rows, row)
	}
	for keyID := range tracker.rates {
		if seen[keyID] {
			continue
		}
		row := LiveRow{KeyID: keyID}
		row.RPM1m, row.RPM5m, row.TPM1m, row.TPM5m = tracker.ratesLocked(keyID, now)
		rows = append(rows, row)
	}
	return rows
}

func (tracker *Tracker) rateAddLocked(
	rings map[string]*rateRing,
	subject string,
	now time.Time,
	requests int64,
	admitted int64,
	tokens int64,
) {
	if subject == "" {
		return
	}
	start := now.UnixMilli() - now.UnixMilli()%rateBucketMS
	ring := rings[subject]
	if ring == nil {
		ring = &rateRing{}
		rings[subject] = ring
	}
	index := int((start / rateBucketMS) % rateSlots)
	if ring.slots[index].startMS != start {
		ring.slots[index] = rateBucket{startMS: start}
	}
	ring.slots[index].requests += requests
	ring.slots[index].admitted += admitted
	ring.slots[index].tokens += tokens
}

// KeyWindow 返回某 Key 在滚动 60s 窗口内已准入的调用数与 token。
func (tracker *Tracker) KeyWindow(keyID string) concurrency.Window {
	return tracker.window(0, keyID)
}

// AccountWindow 返回某账号在滚动 60s 窗口内已准入的调用数与 token。
func (tracker *Tracker) AccountWindow(accountRef string) concurrency.Window {
	return tracker.window(1, accountRef)
}

func (tracker *Tracker) window(kind int, subject string) concurrency.Window {
	if tracker == nil || subject == "" {
		return concurrency.Window{}
	}
	now := tracker.clock()
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	var ring *rateRing
	if kind == 0 {
		ring = tracker.rates[subject]
	} else {
		ring = tracker.accountRates[subject]
	}
	return windowOf(ring, now)
}

func windowOf(ring *rateRing, now time.Time) concurrency.Window {
	var window concurrency.Window
	if ring == nil {
		return window
	}
	nowMS := now.UnixMilli()
	var oldestRequest, oldestToken int64
	for _, slot := range ring.slots {
		if slot.startMS == 0 {
			continue
		}
		age := nowMS - slot.startMS
		if age < 0 || age >= rateWindowMS {
			continue
		}
		if slot.admitted > 0 {
			window.Requests += slot.admitted
			if oldestRequest == 0 || slot.startMS < oldestRequest {
				oldestRequest = slot.startMS
			}
		}
		if slot.tokens > 0 {
			window.Tokens += slot.tokens
			if oldestToken == 0 || slot.startMS < oldestToken {
				oldestToken = slot.startMS
			}
		}
	}
	// 槽位内的样本都发生在 [start, start+1s)，整批过期时刻取上界以给出保守的
	// Retry-After；调用方还会把它收窄到窗口长度。
	if oldestRequest > 0 {
		window.OldestRequestAt = time.UnixMilli(oldestRequest + rateBucketMS + rateWindowMS)
	}
	if oldestToken > 0 {
		window.OldestTokenAt = time.UnixMilli(oldestToken + rateBucketMS + rateWindowMS)
	}
	return window
}

// KeyDailyTokens 返回某 Key 自 UTC 零点起累计的 token。
//
// 口径：已落库的小时桶（跨重启）加上内存里尚未落库的分钟桶；两者互斥（Flush
// 落库后会从内存删除），因此不会重复计数。持久部分按 1s 缓存，避免每个准入判定
// 都查库。
func (tracker *Tracker) KeyDailyTokens(ctx context.Context, keyID string) int64 {
	if tracker == nil || keyID == "" {
		return 0
	}
	now := tracker.clock()
	dayStart := utcDayStartMS(now)
	if !tracker.dailyFresh(keyID, dayStart, now) {
		if persisted, err := tracker.queryDailyTokens(ctx, keyID, dayStart, now); err == nil {
			tracker.mu.Lock()
			tracker.daily[keyID] = dailyCacheEntry{dayStartMS: dayStart, fetchedAt: now, tokens: persisted}
			tracker.mu.Unlock()
		}
	}
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	var persisted int64
	if entry, ok := tracker.daily[keyID]; ok && entry.dayStartMS == dayStart {
		persisted = entry.tokens
	}
	var memory int64
	for key, counts := range tracker.attempts {
		if key.keyID == keyID && key.minute >= dayStart {
			memory += counts.totalTokens
		}
	}
	return persisted + memory
}

func (tracker *Tracker) dailyFresh(keyID string, dayStart int64, now time.Time) bool {
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	entry, ok := tracker.daily[keyID]
	if !ok || entry.dayStartMS != dayStart {
		return false
	}
	return now.Sub(entry.fetchedAt) < dailyCacheTTL
}

func (tracker *Tracker) queryDailyTokens(
	ctx context.Context,
	keyID string,
	dayStartMS int64,
	now time.Time,
) (int64, error) {
	if tracker.store == nil {
		return 0, ErrUnavailable
	}
	// 小时桶已覆盖当日全部分钟桶，行数远少于分钟桶；UTC 零点与整点对齐。
	buckets, err := tracker.store.QueryClientKeyAttempts(ctx, coreclientkeys.StatsQuery{
		Granularity: coreclientkeys.GranularityHour,
		FromMS:      dayStartMS,
		ToMS:        now.UnixMilli() + 1,
		KeyID:       keyID,
	})
	if err != nil {
		return 0, err
	}
	var total int64
	for _, bucket := range buckets {
		total += bucket.TotalTokens
	}
	return total, nil
}

func utcDayStartMS(now time.Time) int64 {
	utc := now.UTC()
	midnight := time.Date(utc.Year(), utc.Month(), utc.Day(), 0, 0, 0, 0, time.UTC)
	return midnight.UnixMilli()
}

func (tracker *Tracker) ratesLocked(keyID string, now time.Time) (rpm1, rpm5, tpm1, tpm5 float64) {
	ring := tracker.rates[keyID]
	if ring == nil {
		return 0, 0, 0, 0
	}
	nowMS := now.UnixMilli()
	var requests1, tokens1, requests5, tokens5 int64
	for _, slot := range ring.slots {
		if slot.startMS == 0 || slot.startMS > nowMS {
			continue
		}
		age := nowMS - slot.startMS
		requests5 += slot.requests
		tokens5 += slot.tokens
		if age <= minuteMS {
			requests1 += slot.requests
			tokens1 += slot.tokens
		}
	}
	rpm1 = float64(requests1)
	rpm5 = float64(requests5) / 5
	tpm1 = float64(tokens1)
	tpm5 = float64(tokens5) / 5
	return rpm1, rpm5, tpm1, tpm5
}

func saturating(value uint64) int64 {
	if value > uint64(^uint64(0)>>1) {
		return int64(^uint64(0) >> 1)
	}
	return int64(value)
}
