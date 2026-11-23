package admission

import (
	"context"
	"strings"
	"sync"
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

// AccountLimitSource 提供账号/账号+模型并发覆盖。
type AccountLimitSource interface {
	ListAccountConcurrencyLimits(ctx context.Context) ([]concurrency.AccountLimit, error)
}

// KeyLimiter 返回 Key 的并发上限（0 表示不限）。
type KeyLimiter func(keyID string) int

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
	request  Request
	keyID    string
	seq      uint64
	ready    chan struct{}
	granted  *Lease
	resolved resolved
}

// Controller 持有配置快照、运行态计数和有界 FIFO 队列。
type Controller struct {
	mu      sync.Mutex
	config  concurrency.Config
	limits  []concurrency.AccountLimit
	keyLim  KeyLimiter
	running int

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
}

// NewController 用给定配置创建控制器。
func NewController(config concurrency.Config) *Controller {
	return &Controller{
		config:         normalizeConfig(config),
		byKey:          map[string]int{},
		byAccount:      map[string]int{},
		byAccountModel: map[string]int{},
		byProvider:     map[string]int{},
	}
}

// Configure 原子替换 server 配置（热更新）。
func (controller *Controller) Configure(config concurrency.Config) {
	if controller == nil {
		return
	}
	controller.mu.Lock()
	controller.config = normalizeConfig(config)
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

// SetKeyLimiter 安装 Key 并发上限解析（0=不限）。
func (controller *Controller) SetKeyLimiter(limiter KeyLimiter) {
	if controller == nil {
		return
	}
	controller.mu.Lock()
	controller.keyLim = limiter
	controller.mu.Unlock()
	controller.wake()
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
//   - 账号/账号+模型自身满额时立即拒绝（ReasonAccountSaturated/ReasonModelSaturated），
//     调用方应换号，而不是占用队列；
//   - 系统/Key 满额时进入有界 FIFO 队列，最多等待 queueWaitTimeoutMs；
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
	entry := &waiter{
		request:  normalized,
		keyID:    keyID,
		seq:      controller.nextSeq,
		ready:    make(chan struct{}),
		resolved: item,
	}
	controller.nextSeq++
	controller.queue = append(controller.queue, entry)
	controller.mu.Unlock()

	timeout := item.waitTimeout
	if timeout <= 0 {
		timeout = time.Duration(concurrency.Default().QueueWaitTimeoutMS) * time.Millisecond
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-entry.ready:
		return entry.granted, nil
	case <-ctx.Done():
		if controller.cancelWaiter(entry) {
			controller.mu.Lock()
			controller.stats.rejected++
			controller.stats.timedOut++
			controller.mu.Unlock()
			return nil, &Rejection{Reason: ReasonCanceled, RetryAfter: item.retryAfter}
		}
		return entry.granted, nil
	case <-timer.C:
		if controller.cancelWaiter(entry) {
			controller.mu.Lock()
			controller.stats.rejected++
			controller.stats.timedOut++
			controller.mu.Unlock()
			return nil, &Rejection{Reason: ReasonWaitTimeout, RetryAfter: item.retryAfter}
		}
		return entry.granted, nil
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
