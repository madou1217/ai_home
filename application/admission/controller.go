package admission

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	coreclientkeys "github.com/madou1217/ai_home/core/clientkeys"
	"github.com/madou1217/ai_home/core/concurrency"
)

// Request 描述一次真实上游调用需要的准入。
type Request struct {
	// Provider 是账号所属 Provider（用于 Provider 默认值）。
	Provider string
	// AccountRef 是账号稳定引用。
	AccountRef string
	// Model 是该次上游调用的有效模型。
	Model string
	// KeyID 是客户端 API Key 身份；空时从 ctx 身份解析。
	KeyID string
}

// AccountLimitSource 提供账号/账号+模型的并发与速率覆盖。
type AccountLimitSource interface {
	ListAccountConcurrencyLimits(ctx context.Context) ([]concurrency.AccountLimit, error)
}

// KeyLimits 是一把 Key 的生效限流；0 表示不限。
type KeyLimits struct {
	MaxConcurrency  int
	RPMLimit        int
	TPMLimit        int
	DailyTokenLimit int
}

// KeyLimitSource 返回 Key 的生效限流；第二返回值表示 Key 是否在活动快照里。
type KeyLimitSource func(keyID string) (KeyLimits, bool)

// resolved 是一次准入在某一时刻解析出的全部天花板。
type resolved struct {
	provider     string
	accountRef   string
	model        string
	keyID        string
	keyLimit     int
	accountLimit int
	modelLimit   int
	systemMax    int
	queueLimit   int
	keyRPM       int
	keyTPM       int
	keyDaily     int
	accountRPM   int
	accountTPM   int
	retryAfter   time.Duration
	waitTimeout  time.Duration
}

func (item resolved) accountModelKey() string {
	if item.accountRef == "" || item.model == "" {
		return ""
	}
	return item.accountRef + "\x00" + item.model
}

// waiter 是队列里的一个等待者。
type waiter struct {
	request    Request
	keyID      string
	seq        uint64
	ready      chan struct{}
	update     chan struct{}
	granted    *Lease
	rejection  *Rejection
	resolved   resolved
	enqueuedAt time.Time
	// deadline 是排队截止时刻（unix nano）；热更新超时会改写它并触发 update。
	deadline atomic.Int64
}

func (item *waiter) deadlineTime() time.Time {
	return time.Unix(0, item.deadline.Load())
}

// outcome 返回等待者被推进后的结果（授权租约或速率拒绝）。
func (item *waiter) outcome() (*Lease, error) {
	if item.rejection != nil {
		return nil, item.rejection
	}
	return item.granted, nil
}

// Controller 持有配置快照、运行态计数和有界 FIFO 队列。
type Controller struct {
	mu         sync.Mutex
	config     concurrency.Config
	limits     []concurrency.AccountLimit
	keyLimits  KeyLimitSource
	rateWindow concurrency.WindowSource
	rateRecord concurrency.AdmissionRecorder
	clock      func() time.Time
	running    int

	byKey          map[string]int
	byAccount      map[string]int
	byAccountModel map[string]int
	byProvider     map[string]int

	queue   []*waiter
	nextSeq uint64

	stats controllerStats
}

type controllerStats struct {
	granted      int64
	rejected     int64
	timedOut     int64
	queueFull    int64
	accountRejct int64
	rateLimited  int64
}

// NewController 用给定配置创建控制器。
func NewController(config concurrency.Config) *Controller {
	return &Controller{
		config:         normalizeConfig(config),
		clock:          time.Now,
		byKey:          map[string]int{},
		byAccount:      map[string]int{},
		byAccountModel: map[string]int{},
		byProvider:     map[string]int{},
	}
}

// Configure 原子替换 server 配置（热更新）。
//
// 排队等待者按新的 queueWaitTimeoutMs 重算截止时刻（相对各自入队时间），并由
// update 通道唤醒，使截止时间以最新配置为准而不是入队时的旧值。
func (controller *Controller) Configure(config concurrency.Config) {
	if controller == nil {
		return
	}
	controller.mu.Lock()
	controller.config = normalizeConfig(config)
	timeout := time.Duration(controller.config.QueueWaitTimeoutMS) * time.Millisecond
	for _, entry := range controller.queue {
		entry.deadline.Store(entry.enqueuedAt.Add(timeout).UnixNano())
		select {
		case entry.update <- struct{}{}:
		default:
		}
	}
	controller.mu.Unlock()
	// 配置放宽后立即给等待者一次机会。
	controller.wake()
}

// SetAccountLimits 原子替换账号/账号+模型覆盖。
func (controller *Controller) SetAccountLimits(limits []concurrency.AccountLimit) {
	if controller == nil {
		return
	}
	copied := make([]concurrency.AccountLimit, len(limits))
	copy(copied, limits)
	controller.mu.Lock()
	controller.limits = copied
	controller.mu.Unlock()
	controller.wake()
}

// SetKeyLimitSource 安装 Key 限流解析（并发 + RPM/TPM/每日 token；0=不限）。
func (controller *Controller) SetKeyLimitSource(source KeyLimitSource) {
	if controller == nil {
		return
	}
	controller.mu.Lock()
	controller.keyLimits = source
	controller.mu.Unlock()
	controller.wake()
}

// SetRateWindows 安装滚动窗口的只读来源（统计器实现）；nil 表示不限流。
func (controller *Controller) SetRateWindows(source concurrency.WindowSource) {
	if controller == nil {
		return
	}
	controller.mu.Lock()
	controller.rateWindow = source
	controller.mu.Unlock()
}

// SetRateRecorder 安装准入记账端口；只有被授予的调用才计入 RPM。
func (controller *Controller) SetRateRecorder(recorder concurrency.AdmissionRecorder) {
	if controller == nil {
		return
	}
	controller.mu.Lock()
	controller.rateRecord = recorder
	controller.mu.Unlock()
}

// Config 返回当前配置快照。
func (controller *Controller) Config() concurrency.Config {
	if controller == nil {
		return concurrency.Default()
	}
	controller.mu.Lock()
	defer controller.mu.Unlock()
	return controller.config
}

// Acquire 在真实上游调用前获取一个在途名额。
//
// 语义：
//   - Key/账号速率上限已满时立即拒绝（ReasonKey*/ReasonAccount*），被拒绝的请求不
//     计入 RPM/TPM，也不会占用队列；
//   - 账号/账号+模型并发满额时立即拒绝（ReasonAccountSaturated/ReasonModelSaturated），
//     调用方应换号，而不是占用队列；
//   - 系统/Key 并发满额时进入有界 FIFO 队列，最多等待 queueWaitTimeoutMs；
//   - 队列已满或等待超时返回 429 契约错误。
func (controller *Controller) Acquire(ctx context.Context, request Request) (*Lease, error) {
	if controller == nil {
		return noopLease(), nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	normalized := normalizeRequest(request)
	keyID := normalized.KeyID
	if keyID == "" {
		if identity, ok := coreclientkeys.IdentityFromContext(ctx); ok {
			keyID = identity.KeyID
		}
	}

	controller.mu.Lock()
	item := controller.resolveLocked(normalized, keyID)
	if rejection := controller.rateRejectionLocked(ctx, item); rejection != nil {
		controller.stats.rejected++
		controller.stats.rateLimited++
		controller.mu.Unlock()
		return nil, rejection
	}
	if controller.canGrantLocked(item) {
		lease := controller.grantLocked(item)
		controller.mu.Unlock()
		return lease, nil
	}
	if reason, own := controller.ownAccountReasonLocked(item); own {
		controller.stats.rejected++
		controller.stats.accountRejct++
		controller.mu.Unlock()
		return nil, &Rejection{Reason: reason, RetryAfter: item.retryAfter}
	}
	queueLimit := item.queueLimit
	if queueLimit > 0 && len(controller.queue) >= queueLimit {
		controller.stats.rejected++
		controller.stats.queueFull++
		controller.mu.Unlock()
		return nil, &Rejection{Reason: ReasonQueueFull, RetryAfter: item.retryAfter}
	}
	now := controller.clock()
	timeout := item.waitTimeout
	if timeout <= 0 {
		timeout = time.Duration(concurrency.Default().QueueWaitTimeoutMS) * time.Millisecond
	}
	entry := &waiter{
		request:    normalized,
		keyID:      keyID,
		seq:        controller.nextSeq,
		ready:      make(chan struct{}),
		update:     make(chan struct{}, 1),
		resolved:   item,
		enqueuedAt: now,
	}
	entry.deadline.Store(now.Add(timeout).UnixNano())
	controller.nextSeq++
	controller.queue = append(controller.queue, entry)
	controller.mu.Unlock()

	// 截止时刻由 entry.deadline 权威决定：配置热更新会改写它并触发 update，因此
	// 不会因为重复扫描/唤醒把等待时间顺延。
	for {
		remaining := time.Until(entry.deadlineTime())
		if remaining <= 0 {
			switch controller.expireWaiter(entry) {
			case waiterExpired:
				controller.mu.Lock()
				controller.stats.rejected++
				controller.stats.timedOut++
				controller.mu.Unlock()
				return nil, &Rejection{Reason: ReasonWaitTimeout, RetryAfter: item.retryAfter}
			case waiterGranted:
				return entry.outcome()
			default:
				continue // 截止时间刚被延长
			}
		}
		timer := time.NewTimer(remaining)
		select {
		case <-entry.ready:
			timer.Stop()
			return entry.outcome()
		case <-ctx.Done():
			timer.Stop()
			if controller.cancelWaiter(entry) {
				controller.mu.Lock()
				controller.stats.rejected++
				controller.stats.timedOut++
				controller.mu.Unlock()
				return nil, &Rejection{Reason: ReasonCanceled, RetryAfter: item.retryAfter}
			}
			return entry.outcome()
		case <-entry.update:
			timer.Stop()
		case <-timer.C:
			// 到期后回到循环顶部重新读取截止时刻，避免与热更新竞态。
		}
	}
}

// TryAcquire 只做一次立即判定，不排队；用于需要“跳过饱和账号”的调用方。
func (controller *Controller) TryAcquire(ctx context.Context, request Request) (*Lease, error) {
	if controller == nil {
		return noopLease(), nil
	}
	normalized := normalizeRequest(request)
	keyID := normalized.KeyID
	if keyID == "" && ctx != nil {
		if identity, ok := coreclientkeys.IdentityFromContext(ctx); ok {
			keyID = identity.KeyID
		}
	}
	controller.mu.Lock()
	item := controller.resolveLocked(normalized, keyID)
	if rejection := controller.rateRejectionLocked(ctx, item); rejection != nil {
		controller.stats.rejected++
		controller.stats.rateLimited++
		controller.mu.Unlock()
		return nil, rejection
	}
	if controller.canGrantLocked(item) {
		lease := controller.grantLocked(item)
		controller.mu.Unlock()
		return lease, nil
	}
	if reason, own := controller.ownAccountReasonLocked(item); own {
		controller.stats.rejected++
		controller.stats.accountRejct++
		controller.mu.Unlock()
		return nil, &Rejection{Reason: reason, RetryAfter: item.retryAfter}
	}
	controller.stats.rejected++
	controller.mu.Unlock()
	return nil, &Rejection{Reason: ReasonWaitTimeout, RetryAfter: item.retryAfter}
}

// waiterState 是到期处理的三种结果。
type waiterState int

const (
	waiterQueued waiterState = iota
	waiterExpired
	waiterGranted
)

// expireWaiter 在锁内确认等待者仍排队且已到期，然后移除它。
func (controller *Controller) expireWaiter(entry *waiter) waiterState {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	for index, candidate := range controller.queue {
		if candidate != entry {
			continue
		}
		if controller.clock().Before(entry.deadlineTime()) {
			return waiterQueued
		}
		controller.queue = append(controller.queue[:index], controller.queue[index+1:]...)
		return waiterExpired
	}
	return waiterGranted
}

// cancelWaiter 从队列移除等待者；返回 true 表示它还没被授予。
func (controller *Controller) cancelWaiter(entry *waiter) bool {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	for index, candidate := range controller.queue {
		if candidate == entry {
			controller.queue = append(controller.queue[:index], controller.queue[index+1:]...)
			return true
		}
	}
	return false
}

// wake 触发一次队列推进（配置/限额变化后）。
func (controller *Controller) wake() {
	if controller == nil {
		return
	}
	controller.mu.Lock()
	controller.promoteLocked()
	controller.mu.Unlock()
}

// canGrantLocked 判定当前计数是否允许授予。
func (controller *Controller) canGrantLocked(item resolved) bool {
	if item.systemMax > 0 && controller.running >= item.systemMax {
		return false
	}
	if item.keyLimit > 0 && controller.byKey[item.keyID] >= item.keyLimit {
		return false
	}
	if item.accountLimit > 0 && controller.byAccount[item.accountRef] >= item.accountLimit {
		return false
	}
	if item.modelLimit > 0 {
		if key := item.accountModelKey(); key != "" &&
			controller.byAccountModel[key] >= item.modelLimit {
			return false
		}
	}
	return true
}

// ownAccountReasonLocked 报告是否只因目标账号/模型自身满额而无法授予。
func (controller *Controller) ownAccountReasonLocked(item resolved) (Reason, bool) {
	if item.accountLimit > 0 && controller.byAccount[item.accountRef] >= item.accountLimit {
		return ReasonAccountSaturated, true
	}
	if item.modelLimit > 0 {
		if key := item.accountModelKey(); key != "" &&
			controller.byAccountModel[key] >= item.modelLimit {
			return ReasonModelSaturated, true
		}
	}
	return "", false
}

// grantLocked 增加全部计数并返回租约。
func (controller *Controller) grantLocked(item resolved) *Lease {
	controller.running++
	controller.stats.granted++
	controller.byProvider[item.provider]++
	if item.keyID != "" {
		controller.byKey[item.keyID]++
	}
	if item.accountRef != "" {
		controller.byAccount[item.accountRef]++
		if key := item.accountModelKey(); key != "" {
			controller.byAccountModel[key]++
		}
	}
	// 只有被准入的调用才计入 RPM；被拒绝的请求不消耗名额。
	if controller.rateRecord != nil {
		controller.rateRecord.RecordAdmitted(item.keyID, item.accountRef)
	}
	return &Lease{controller: controller, item: item}
}

// promoteLocked 按 FIFO 顺序扫描队列并授予当前可授予的等待者。
//
// 只被自身 Key 上限挡住的等待者会被跳过，继续检查后面的等待者，因此一个 Key 的
// 饱和不会队头阻塞其他 Key。被账号上限挡住的等待者同样跳过（调用方本应换号）。
func (controller *Controller) promoteLocked() {
	for index := 0; index < len(controller.queue); {
		entry := controller.queue[index]
		entry.resolved = controller.resolveLocked(entry.request, entry.keyID)
		// 排队期间其他请求可能用掉了 Key/账号的速率名额：重新判定，命中则直接以
		// 速率拒绝结束等待，而不是继续占用队列。
		if rejection := controller.rateRejectionLocked(context.Background(), entry.resolved); rejection != nil {
			controller.queue = append(controller.queue[:index], controller.queue[index+1:]...)
			controller.stats.rejected++
			controller.stats.rateLimited++
			entry.rejection = rejection
			close(entry.ready)
			continue
		}
		if !controller.canGrantLocked(entry.resolved) {
			index++
			continue
		}
		controller.queue = append(controller.queue[:index], controller.queue[index+1:]...)
		entry.granted = controller.grantLocked(entry.resolved)
		close(entry.ready)
	}
}

func (controller *Controller) release(item resolved) {
	if controller == nil {
		return
	}
	controller.mu.Lock()
	if controller.running > 0 {
		controller.running--
	}
	dec(controller.byProvider, item.provider)
	if item.keyID != "" {
		dec(controller.byKey, item.keyID)
	}
	if item.accountRef != "" {
		dec(controller.byAccount, item.accountRef)
		if key := item.accountModelKey(); key != "" {
			dec(controller.byAccountModel, key)
		}
	}
	controller.promoteLocked()
	controller.mu.Unlock()
}

// rateRejectionLocked 判定 Key/账号的滚动速率与每日 token 上限。
//
// 口径：
//   - Key RPM/TPM：窗口内已准入的真实上游调用与 token；Key 每日 token：UTC 零点起；
//   - 账号 RPM/TPM：按账号聚合的同一批已准入调用与 token。
//
// 命中返回带 Retry-After 的强类型拒绝；被拒绝的请求不会写回统计。
func (controller *Controller) rateRejectionLocked(ctx context.Context, item resolved) *Rejection {
	source := controller.rateWindow
	if source == nil {
		return nil
	}
	now := controller.clock()
	if item.keyID != "" {
		if item.keyRPM > 0 || item.keyTPM > 0 {
			window := source.KeyWindow(item.keyID)
			if item.keyRPM > 0 && window.Requests >= int64(item.keyRPM) {
				return &Rejection{
					Reason:     ReasonKeyRPM,
					RetryAfter: rollingRetryAfter(window.OldestRequestAt, now),
				}
			}
			if item.keyTPM > 0 && window.Tokens >= int64(item.keyTPM) {
				return &Rejection{
					Reason:     ReasonKeyTPM,
					RetryAfter: rollingRetryAfter(window.OldestTokenAt, now),
				}
			}
		}
		if item.keyDaily > 0 {
			if tokens := source.KeyDailyTokens(ctx, item.keyID); tokens >= int64(item.keyDaily) {
				return &Rejection{Reason: ReasonKeyDailyTokens, RetryAfter: dailyRetryAfter(now)}
			}
		}
	}
	if item.accountRef != "" && (item.accountRPM > 0 || item.accountTPM > 0) {
		window := source.AccountWindow(item.accountRef)
		if item.accountRPM > 0 && window.Requests >= int64(item.accountRPM) {
			return &Rejection{
				Reason:     ReasonAccountRPM,
				RetryAfter: rollingRetryAfter(window.OldestRequestAt, now),
			}
		}
		if item.accountTPM > 0 && window.Tokens >= int64(item.accountTPM) {
			return &Rejection{
				Reason:     ReasonAccountTPM,
				RetryAfter: rollingRetryAfter(window.OldestTokenAt, now),
			}
		}
	}
	return nil
}

// rollingRetryAfter 返回滚动窗口释放容量前需要等待的时间。
//
// 最老样本整体过期时为窗口腾出容量；上限不超过窗口长度（60s），下限 1s。
func rollingRetryAfter(expiry time.Time, now time.Time) time.Duration {
	const window = time.Minute
	wait := expiry.Sub(now)
	if expiry.IsZero() || wait > window {
		wait = window
	}
	if wait < time.Second {
		wait = time.Second
	}
	return wait
}

// dailyRetryAfter 返回距离下一个 UTC 零点的时长（上限一天，下限 1s）。
func dailyRetryAfter(now time.Time) time.Duration {
	utc := now.UTC()
	next := time.Date(utc.Year(), utc.Month(), utc.Day()+1, 0, 0, 0, 0, time.UTC)
	wait := next.Sub(now)
	if wait > 24*time.Hour {
		wait = 24 * time.Hour
	}
	if wait < time.Second {
		wait = time.Second
	}
	return wait
}

func dec(counters map[string]int, key string) {
	if key == "" {
		return
	}
	if value := counters[key]; value > 1 {
		counters[key] = value - 1
		return
	}
	delete(counters, key)
}

// Lease 是已获得的在途名额；Release 恰好一次生效。
type Lease struct {
	once       sync.Once
	controller *Controller
	item       resolved
}

// Release 归还名额并推进等待队列；重复调用无副作用。
func (lease *Lease) Release() {
	if lease == nil {
		return
	}
	lease.once.Do(func() {
		if lease.controller != nil {
			lease.controller.release(lease.item)
		}
	})
}

func noopLease() *Lease { return &Lease{} }

// normalizeRequest 归一化字符串字段。
func normalizeRequest(request Request) Request {
	return Request{
		Provider:   strings.ToLower(strings.TrimSpace(request.Provider)),
		AccountRef: strings.TrimSpace(request.AccountRef),
		Model:      strings.TrimSpace(request.Model),
		KeyID:      strings.TrimSpace(request.KeyID),
	}
}

func normalizeConfig(config concurrency.Config) concurrency.Config {
	defaults := concurrency.Default()
	if config.QueueLimit <= 0 {
		config.QueueLimit = defaults.QueueLimit
	}
	if config.QueueWaitTimeoutMS <= 0 {
		config.QueueWaitTimeoutMS = defaults.QueueWaitTimeoutMS
	}
	if config.RetryAfterSeconds <= 0 {
		config.RetryAfterSeconds = defaults.RetryAfterSeconds
	}
	if config.ProviderDefaults == nil {
		config.ProviderDefaults = defaults.ProviderDefaults
	}
	return config
}
