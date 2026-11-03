package accountusage

import (
	"container/heap"
	"context"
	"errors"
	"sync"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

var (
	// ErrInvalidCoordinator 表示后台刷新缺少 Provider、执行器、并发或时间配置。
	ErrInvalidCoordinator = errors.New("账号额度刷新协调器配置无效")
	// ErrInvalidSchedule 表示任务账号或 Provider 无效。
	ErrInvalidSchedule = errors.New("账号额度刷新任务无效")
	// ErrCoordinatorClosed 表示协调器已经停止接收任务。
	ErrCoordinatorClosed = errors.New("账号额度刷新协调器已关闭")
)

// UsageRefresher 是后台 worker 调用的单账号刷新端口。
type UsageRefresher interface {
	RefreshUsage(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (ReadResult, error)
}

// RefreshResult 是观察端口收到的低敏后台执行事实。
type RefreshResult struct {
	AccountRef accountcore.AccountRef
	ProviderID string
	Err        error
}

// RefreshObserver 接收后台结果，不参与刷新正确性。
type RefreshObserver func(result RefreshResult)

// CoordinatorOptions 显式配置周期、错峰、Provider 隔离并发和失败退避。
type CoordinatorOptions struct {
	Catalog             *providers.Catalog
	Refresher           UsageRefresher
	ProviderConcurrency map[string]int
	RefreshTimeout      time.Duration
	RefreshInterval     time.Duration
	StaggerWindow       time.Duration
	BaseBackoff         time.Duration
	MaxBackoff          time.Duration
	Clock               Clock
	Observer            RefreshObserver
}

// Coordinator 使用最小堆管理到期时间，并用独立 Provider worker 隔离上游。
type Coordinator struct {
	mu            sync.Mutex
	catalog       *providers.Catalog
	refresher     UsageRefresher
	timeout       time.Duration
	interval      time.Duration
	staggerWindow time.Duration
	baseBackoff   time.Duration
	maxBackoff    time.Duration
	clock         Clock
	observer      RefreshObserver
	ctx           context.Context
	cancel        context.CancelFunc
	wake          chan struct{}
	tasks         map[accountcore.AccountRef]*scheduledRefresh
	schedule      refreshHeap
	providers     map[string]*providerQueue
	closed        bool
	workers       sync.WaitGroup
}

// scheduledRefresh 是一个账号在堆、Provider 队列或执行中的唯一状态。
type scheduledRefresh struct {
	accountRef accountcore.AccountRef
	providerID string
	dueAt      time.Time
	failures   uint32
	index      int
	running    bool
	rerun      bool
	cancel     context.CancelFunc
}

// providerQueue 保存单 Provider 已到期任务和唤醒信号。
type providerQueue struct {
	tasks  []*scheduledRefresh
	head   int
	notify chan struct{}
}

// NewCoordinator 创建立即启动调度循环和 Provider worker 的协调器。
func NewCoordinator(options CoordinatorOptions) (*Coordinator, error) {
	if !validCoordinatorOptions(options) {
		return nil, ErrInvalidCoordinator
	}
	ctx, cancel := context.WithCancel(context.Background())
	coordinator := &Coordinator{
		catalog:       options.Catalog,
		refresher:     options.Refresher,
		timeout:       options.RefreshTimeout,
		interval:      options.RefreshInterval,
		staggerWindow: options.StaggerWindow,
		baseBackoff:   options.BaseBackoff,
		maxBackoff:    options.MaxBackoff,
		clock:         options.Clock,
		observer:      options.Observer,
		ctx:           ctx,
		cancel:        cancel,
		wake:          make(chan struct{}),
		tasks:         make(map[accountcore.AccountRef]*scheduledRefresh),
		providers:     make(map[string]*providerQueue),
	}
	heap.Init(&coordinator.schedule)
	coordinator.workers.Add(1)
	go coordinator.runScheduler()
	for providerID, concurrency := range options.ProviderConcurrency {
		queue := &providerQueue{notify: make(chan struct{})}
		coordinator.providers[providerID] = queue
		coordinator.workers.Add(concurrency)
		for range concurrency {
			go coordinator.runProviderWorker(providerID, queue)
		}
	}
	return coordinator, nil
}

// ScheduleUsageRefresh 把显式管理或账号生命周期信号合并为立即任务。
func (coordinator *Coordinator) ScheduleUsageRefresh(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	providerID string,
) error {
	return coordinator.scheduleRefresh(ctx, accountRef, providerID, false)
}

// ScheduleInitialUsageRefresh 使用 AccountRef 确定性错峰启动已有账号。
func (coordinator *Coordinator) ScheduleInitialUsageRefresh(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	providerID string,
) error {
	return coordinator.scheduleRefresh(ctx, accountRef, providerID, true)
}

// ForgetAccount 移除待调度任务，并取消已经开始的旧账号任务。
//
// 队列中的任务对象依靠指针身份延迟失效，允许同一 AccountRef 被快速重新导入。
func (coordinator *Coordinator) ForgetAccount(
	accountRef accountcore.AccountRef,
) {
	if coordinator == nil || !accountRef.IsValid() {
		return
	}
	coordinator.mu.Lock()
	task := coordinator.tasks[accountRef]
	if task == nil {
		coordinator.mu.Unlock()
		return
	}
	delete(coordinator.tasks, accountRef)
	if task.index >= 0 {
		heap.Remove(&coordinator.schedule, task.index)
		coordinator.signalScheduler()
	}
	cancel := task.cancel
	coordinator.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// scheduleRefresh 校验任务，并更新同账号唯一堆节点。
func (coordinator *Coordinator) scheduleRefresh(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	providerID string,
	staggered bool,
) error {
	if coordinator == nil ||
		ctx == nil ||
		!accountRef.IsValid() {
		return ErrInvalidSchedule
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	canonicalProviderID, found := coordinator.catalog.CanonicalID(providerID)
	if !found || canonicalProviderID != providerID {
		return ErrInvalidSchedule
	}
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	if coordinator.closed {
		return ErrCoordinatorClosed
	}
	if coordinator.providers[providerID] == nil {
		return ErrInvalidSchedule
	}
	dueAt := coordinator.clock()
	if staggered {
		dueAt = dueAt.Add(coordinator.deterministicStagger(accountRef))
	}
	if current := coordinator.tasks[accountRef]; current != nil {
		if current.providerID != providerID {
			return ErrInvalidSchedule
		}
		if current.running {
			if !staggered {
				current.rerun = true
			}
			return nil
		}
		if !dueAt.Before(current.dueAt) {
			return nil
		}
		current.dueAt = dueAt
		heap.Fix(&coordinator.schedule, current.index)
		coordinator.signalScheduler()
		return nil
	}
	task := &scheduledRefresh{
		accountRef: accountRef,
		providerID: providerID,
		dueAt:      dueAt,
		index:      -1,
	}
	coordinator.tasks[accountRef] = task
	heap.Push(&coordinator.schedule, task)
	coordinator.signalScheduler()
	return nil
}

// Close 停止接收任务、取消执行并等待全部 goroutine 退出。
func (coordinator *Coordinator) Close() error {
	if coordinator == nil {
		return nil
	}
	coordinator.mu.Lock()
	if coordinator.closed {
		coordinator.mu.Unlock()
		return nil
	}
	coordinator.closed = true
	coordinator.cancel()
	coordinator.signalScheduler()
	for _, queue := range coordinator.providers {
		signalProviderQueue(queue)
	}
	coordinator.mu.Unlock()
	coordinator.workers.Wait()
	return nil
}

// runScheduler 按最小到期时间把任务分发到对应 Provider 队列。
func (coordinator *Coordinator) runScheduler() {
	defer coordinator.workers.Done()
	for {
		coordinator.mu.Lock()
		if coordinator.closed {
			coordinator.mu.Unlock()
			return
		}
		if coordinator.schedule.Len() == 0 {
			wake := coordinator.wake
			coordinator.mu.Unlock()
			if !waitForCoordinator(coordinator.ctx, wake, 0) {
				return
			}
			continue
		}
		wait := coordinator.schedule[0].dueAt.Sub(coordinator.clock())
		if wait > 0 {
			wake := coordinator.wake
			coordinator.mu.Unlock()
			if !waitForCoordinator(coordinator.ctx, wake, wait) {
				return
			}
			continue
		}
		now := coordinator.clock()
		signals := make(map[*providerQueue]struct{})
		for coordinator.schedule.Len() > 0 &&
			!coordinator.schedule[0].dueAt.After(now) {
			task := heap.Pop(&coordinator.schedule).(*scheduledRefresh)
			task.running = true
			queue := coordinator.providers[task.providerID]
			queue.tasks = append(queue.tasks, task)
			signals[queue] = struct{}{}
		}
		for queue := range signals {
			signalProviderQueue(queue)
		}
		coordinator.mu.Unlock()
	}
}

// runProviderWorker 顺序执行一个 Provider 队列中的单账号刷新。
func (coordinator *Coordinator) runProviderWorker(
	providerID string,
	queue *providerQueue,
) {
	defer coordinator.workers.Done()
	for {
		task, refreshCtx, available := coordinator.nextProviderTask(queue)
		if !available {
			return
		}
		_, err := coordinator.refresher.RefreshUsage(
			refreshCtx,
			task.accountRef,
		)
		coordinator.finishRefresh(providerID, task, err)
	}
}

// nextProviderTask 等待并弹出一个已到期账号。
func (coordinator *Coordinator) nextProviderTask(
	queue *providerQueue,
) (*scheduledRefresh, context.Context, bool) {
	for {
		coordinator.mu.Lock()
		if coordinator.closed {
			coordinator.mu.Unlock()
			return nil, nil, false
		}
		for {
			task, available := popProviderTask(queue)
			if !available {
				break
			}
			if coordinator.tasks[task.accountRef] != task ||
				!task.running {
				continue
			}
			refreshCtx, cancel := context.WithTimeout(
				coordinator.ctx,
				coordinator.timeout,
			)
			task.cancel = cancel
			coordinator.mu.Unlock()
			return task, refreshCtx, true
		}
		notify := queue.notify
		coordinator.mu.Unlock()
		select {
		case <-coordinator.ctx.Done():
			return nil, nil, false
		case <-notify:
		}
	}
}

// popProviderTask 使用游标均摊 O(1) 出队，并周期压缩长期繁忙队列。
func popProviderTask(
	queue *providerQueue,
) (*scheduledRefresh, bool) {
	if queue == nil || queue.head >= len(queue.tasks) {
		return nil, false
	}
	task := queue.tasks[queue.head]
	queue.tasks[queue.head] = nil
	queue.head++
	if queue.head == len(queue.tasks) {
		queue.tasks = queue.tasks[:0]
		queue.head = 0
		return task, true
	}
	const compactThreshold = 1_024
	if queue.head >= compactThreshold &&
		queue.head*2 >= len(queue.tasks) {
		remaining := copy(queue.tasks, queue.tasks[queue.head:])
		clear(queue.tasks[remaining:])
		queue.tasks = queue.tasks[:remaining]
		queue.head = 0
	}
	return task, true
}

// finishRefresh 计算下一周期或账号级有界退避，并重新放回最小堆。
func (coordinator *Coordinator) finishRefresh(
	providerID string,
	task *scheduledRefresh,
	refreshErr error,
) {
	coordinator.mu.Lock()
	var cancel context.CancelFunc
	if task != nil && task.cancel != nil {
		cancel = task.cancel
		task.cancel = nil
	}
	if task == nil ||
		coordinator.tasks[task.accountRef] != task ||
		task.providerID != providerID {
		coordinator.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		return
	}
	task.running = false
	if coordinator.closed || errors.Is(refreshErr, ErrUsageUnsupported) {
		delete(coordinator.tasks, task.accountRef)
	} else {
		now := coordinator.clock()
		switch {
		case task.rerun:
			task.rerun = false
			task.dueAt = now
		case refreshErr == nil:
			task.failures = 0
			task.dueAt = now.Add(coordinator.interval)
		default:
			task.failures++
			task.dueAt = now.Add(coordinator.backoff(task))
		}
		heap.Push(&coordinator.schedule, task)
		coordinator.signalScheduler()
	}
	observer := coordinator.observer
	coordinator.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if observer != nil {
		observer(RefreshResult{
			AccountRef: task.accountRef,
			ProviderID: providerID,
			Err:        refreshErr,
		})
	}
}

// backoff 计算账号级指数退避，并使用稳定身份产生小幅确定性错峰。
func (coordinator *Coordinator) backoff(
	task *scheduledRefresh,
) time.Duration {
	delay := coordinator.baseBackoff
	for attempt := uint32(1); attempt < task.failures && delay < coordinator.maxBackoff; attempt++ {
		if delay > coordinator.maxBackoff/2 {
			delay = coordinator.maxBackoff
			break
		}
		delay *= 2
	}
	if delay >= coordinator.maxBackoff {
		return coordinator.maxBackoff
	}
	jitterWindow := delay / 4
	if jitterWindow <= 0 {
		return delay
	}
	jitter := time.Duration(stableAccountHash(task.accountRef) % uint64(jitterWindow))
	if delay+jitter > coordinator.maxBackoff {
		return coordinator.maxBackoff
	}
	return delay + jitter
}

// deterministicStagger 把账号稳定散布到配置窗口内。
func (coordinator *Coordinator) deterministicStagger(
	accountRef accountcore.AccountRef,
) time.Duration {
	if coordinator.staggerWindow <= 0 {
		return 0
	}
	return time.Duration(
		stableAccountHash(accountRef) % uint64(coordinator.staggerWindow),
	)
}

// stableAccountHash 使用固定 FNV-1a 计算，不依赖进程随机种子。
func stableAccountHash(accountRef accountcore.AccountRef) uint64 {
	const offset64 = uint64(14695981039346656037)
	const prime64 = uint64(1099511628211)
	hash := offset64
	for _, value := range []byte(accountRef.String()) {
		hash ^= uint64(value)
		hash *= prime64
	}
	return hash
}

// signalScheduler 在锁内广播堆顶变化。
func (coordinator *Coordinator) signalScheduler() {
	close(coordinator.wake)
	coordinator.wake = make(chan struct{})
}

// signalProviderQueue 在锁内广播 Provider 队列变化。
func signalProviderQueue(queue *providerQueue) {
	close(queue.notify)
	queue.notify = make(chan struct{})
}

// waitForCoordinator 等待任务变化、到期时间或关闭。
func waitForCoordinator(
	ctx context.Context,
	wake <-chan struct{},
	delay time.Duration,
) bool {
	if delay <= 0 {
		select {
		case <-ctx.Done():
			return false
		case <-wake:
			return true
		}
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-wake:
		return true
	case <-timer.C:
		return true
	}
}

// validCoordinatorOptions 拒绝未知 Provider、无界并发和不一致时间配置。
func validCoordinatorOptions(options CoordinatorOptions) bool {
	if options.Catalog == nil ||
		options.Refresher == nil ||
		options.RefreshTimeout <= 0 ||
		options.RefreshInterval <= 0 ||
		options.StaggerWindow < 0 ||
		options.StaggerWindow >= options.RefreshInterval ||
		options.BaseBackoff <= 0 ||
		options.MaxBackoff < options.BaseBackoff ||
		options.Clock == nil ||
		len(options.ProviderConcurrency) == 0 {
		return false
	}
	for providerID, concurrency := range options.ProviderConcurrency {
		canonicalProviderID, found := options.Catalog.CanonicalID(providerID)
		if !found ||
			canonicalProviderID != providerID ||
			concurrency < 1 ||
			concurrency > 64 {
			return false
		}
	}
	return true
}

// refreshHeap 按到期时间和 AccountRef 提供确定性最小堆。
type refreshHeap []*scheduledRefresh

func (items refreshHeap) Len() int { return len(items) }

func (items refreshHeap) Less(left int, right int) bool {
	if items[left].dueAt.Equal(items[right].dueAt) {
		return items[left].accountRef.String() < items[right].accountRef.String()
	}
	return items[left].dueAt.Before(items[right].dueAt)
}

func (items refreshHeap) Swap(left int, right int) {
	items[left], items[right] = items[right], items[left]
	items[left].index = left
	items[right].index = right
}

func (items *refreshHeap) Push(value any) {
	task := value.(*scheduledRefresh)
	task.index = len(*items)
	*items = append(*items, task)
}

func (items *refreshHeap) Pop() any {
	old := *items
	last := len(old) - 1
	task := old[last]
	old[last] = nil
	task.index = -1
	*items = old[:last]
	return task
}
