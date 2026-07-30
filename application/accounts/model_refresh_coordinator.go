package accounts

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"sync"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

var (
	// ErrInvalidModelRefreshCoordinator 表示异步刷新缺少执行器、Provider 并发或退避配置。
	ErrInvalidModelRefreshCoordinator = errors.New("账号模型异步刷新协调器配置无效")
	// ErrInvalidModelRefreshSchedule 表示刷新任务缺少上下文、账号或受支持 Provider。
	ErrInvalidModelRefreshSchedule = errors.New("账号模型异步刷新任务无效")
	// ErrModelRefreshCoordinatorClosed 表示协调器已经停止接收新任务。
	ErrModelRefreshCoordinatorClosed = errors.New("账号模型异步刷新协调器已关闭")
)

// AccountModelRefresher 是异步协调器调用的单账号刷新最小端口。
type AccountModelRefresher interface {
	RefreshAccountModels(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) ([]AccountModel, error)
}

// ModelRefreshResult 是异步刷新观察端口收到的低敏执行事实。
type ModelRefreshResult struct {
	// AccountRef 是完成或失败的稳定账号身份。
	AccountRef accountcore.AccountRef
	// ProviderID 是任务进入的规范 Provider 队列。
	ProviderID string
	// Err 是刷新失败；成功时为空。
	Err error
}

// ModelRefreshObserver 接收异步任务结果，不参与刷新正确性。
type ModelRefreshObserver func(result ModelRefreshResult)

// ModelRefreshCoordinatorOptions 显式配置 Provider 隔离并发和失败退避。
type ModelRefreshCoordinatorOptions struct {
	// Catalog 校验任务 Provider，不复制 Provider 具体实现。
	Catalog *providers.Catalog
	// Refresher 执行凭据读取、目录发现和原子快照替换。
	Refresher AccountModelRefresher
	// ProviderConcurrency 是当前启用刷新 Provider 各自的 worker 数。
	ProviderConcurrency map[string]int
	// RefreshTimeout 限制单次上游目录刷新占用 worker 的时间。
	RefreshTimeout time.Duration
	// BaseBackoff 是 Provider 首次刷新失败后的最小等待。
	BaseBackoff time.Duration
	// MaxBackoff 是同 Provider 连续失败的退避上限。
	MaxBackoff time.Duration
	// Clock 提供退避截止时间。
	Clock Clock
	// Random 提供不超过退避四分之一的抖动随机数。
	Random io.Reader
	// Observer 接收成功或失败结果；为空时只执行刷新。
	Observer ModelRefreshObserver
}

// ModelRefreshCoordinator 使用 Provider 隔离队列异步刷新账号模型快照。
type ModelRefreshCoordinator struct {
	mu          sync.Mutex
	catalog     *providers.Catalog
	refresher   AccountModelRefresher
	timeout     time.Duration
	baseBackoff time.Duration
	maxBackoff  time.Duration
	clock       Clock
	random      io.Reader
	observer    ModelRefreshObserver
	ctx         context.Context
	cancel      context.CancelFunc
	providers   map[string]*modelRefreshProviderQueue
	pending     map[accountcore.AccountRef]string
	closed      bool
	workers     sync.WaitGroup
}

// modelRefreshProviderQueue 保存一个 Provider 的队列、通知和共享退避状态。
type modelRefreshProviderQueue struct {
	tasks         []accountcore.AccountRef
	notify        chan struct{}
	failures      uint32
	nextAttemptAt time.Time
}

// NewModelRefreshCoordinator 创建立即启动 Provider worker 的异步协调器。
func NewModelRefreshCoordinator(
	options ModelRefreshCoordinatorOptions,
) (*ModelRefreshCoordinator, error) {
	if !validModelRefreshOptions(options) {
		return nil, ErrInvalidModelRefreshCoordinator
	}
	ctx, cancel := context.WithCancel(context.Background())
	coordinator := &ModelRefreshCoordinator{
		catalog:     options.Catalog,
		refresher:   options.Refresher,
		timeout:     options.RefreshTimeout,
		baseBackoff: options.BaseBackoff,
		maxBackoff:  options.MaxBackoff,
		clock:       options.Clock,
		random:      options.Random,
		observer:    options.Observer,
		ctx:         ctx,
		cancel:      cancel,
		providers:   make(map[string]*modelRefreshProviderQueue),
		pending:     make(map[accountcore.AccountRef]string),
	}
	for providerID, concurrency := range options.ProviderConcurrency {
		queue := &modelRefreshProviderQueue{notify: make(chan struct{})}
		coordinator.providers[providerID] = queue
		coordinator.workers.Add(concurrency)
		for range concurrency {
			go coordinator.runProviderWorker(providerID, queue)
		}
	}
	return coordinator, nil
}

// ScheduleModelRefresh 合并同账号任务并放入对应 Provider 隔离队列。
func (coordinator *ModelRefreshCoordinator) ScheduleModelRefresh(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	providerID string,
) error {
	if coordinator == nil ||
		ctx == nil ||
		!accountRef.IsValid() {
		return ErrInvalidModelRefreshSchedule
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	canonicalProviderID, found := coordinator.catalog.CanonicalID(providerID)
	if !found || canonicalProviderID != providerID {
		return ErrInvalidModelRefreshSchedule
	}
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	if coordinator.closed {
		return ErrModelRefreshCoordinatorClosed
	}
	queue := coordinator.providers[providerID]
	if queue == nil {
		return ErrInvalidModelRefreshSchedule
	}
	if _, pending := coordinator.pending[accountRef]; pending {
		return nil
	}
	coordinator.pending[accountRef] = providerID
	queue.tasks = append(queue.tasks, accountRef)
	signalModelRefreshQueue(queue)
	return nil
}

// Close 停止接收新任务并等待所有 Provider worker 退出。
func (coordinator *ModelRefreshCoordinator) Close() error {
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
	for _, queue := range coordinator.providers {
		signalModelRefreshQueue(queue)
	}
	coordinator.mu.Unlock()
	coordinator.workers.Wait()
	return nil
}

// runProviderWorker 顺序获取一个 Provider 的任务并执行有界刷新。
func (coordinator *ModelRefreshCoordinator) runProviderWorker(
	providerID string,
	queue *modelRefreshProviderQueue,
) {
	defer coordinator.workers.Done()
	for {
		accountRef, available := coordinator.nextModelRefreshTask(queue)
		if !available {
			return
		}
		refreshCtx, cancel := context.WithTimeout(
			coordinator.ctx,
			coordinator.timeout,
		)
		_, err := coordinator.refresher.RefreshAccountModels(
			refreshCtx,
			accountRef,
		)
		cancel()
		coordinator.finishModelRefresh(providerID, queue, accountRef, err)
	}
}

// nextModelRefreshTask 等待队列或 Provider 退避截止，并弹出一个任务。
func (coordinator *ModelRefreshCoordinator) nextModelRefreshTask(
	queue *modelRefreshProviderQueue,
) (accountcore.AccountRef, bool) {
	for {
		coordinator.mu.Lock()
		if coordinator.closed {
			coordinator.mu.Unlock()
			return "", false
		}
		if len(queue.tasks) == 0 {
			notify := queue.notify
			coordinator.mu.Unlock()
			if !waitForModelRefreshSignal(coordinator.ctx, notify, 0) {
				return "", false
			}
			continue
		}
		wait := queue.nextAttemptAt.Sub(coordinator.clock())
		if wait > 0 {
			notify := queue.notify
			coordinator.mu.Unlock()
			if !waitForModelRefreshSignal(coordinator.ctx, notify, wait) {
				return "", false
			}
			continue
		}
		accountRef := queue.tasks[0]
		copy(queue.tasks, queue.tasks[1:])
		queue.tasks[len(queue.tasks)-1] = ""
		queue.tasks = queue.tasks[:len(queue.tasks)-1]
		coordinator.mu.Unlock()
		return accountRef, true
	}
}

// finishModelRefresh 更新 Provider 退避、释放账号合并标记并通知观察端口。
func (coordinator *ModelRefreshCoordinator) finishModelRefresh(
	providerID string,
	queue *modelRefreshProviderQueue,
	accountRef accountcore.AccountRef,
	refreshErr error,
) {
	coordinator.mu.Lock()
	delete(coordinator.pending, accountRef)
	if refreshErr == nil {
		queue.failures = 0
		queue.nextAttemptAt = time.Time{}
	} else {
		queue.failures++
		delay := coordinator.modelRefreshBackoff(queue.failures)
		queue.nextAttemptAt = coordinator.clock().Add(delay)
	}
	signalModelRefreshQueue(queue)
	observer := coordinator.observer
	coordinator.mu.Unlock()
	if observer != nil {
		observer(ModelRefreshResult{
			AccountRef: accountRef,
			ProviderID: providerID,
			Err:        refreshErr,
		})
	}
}

// modelRefreshBackoff 计算有上限指数退避和最多四分之一抖动。
func (coordinator *ModelRefreshCoordinator) modelRefreshBackoff(
	failures uint32,
) time.Duration {
	delay := coordinator.baseBackoff
	for attempt := uint32(1); attempt < failures && delay < coordinator.maxBackoff; attempt++ {
		if delay > coordinator.maxBackoff/2 {
			delay = coordinator.maxBackoff
			break
		}
		delay *= 2
	}
	if delay >= coordinator.maxBackoff {
		return coordinator.maxBackoff
	}
	jitterLimit := delay / 4
	if jitterLimit <= 0 {
		return delay
	}
	var randomBytes [8]byte
	if _, err := io.ReadFull(coordinator.random, randomBytes[:]); err != nil {
		return delay
	}
	jitter := time.Duration(
		binary.LittleEndian.Uint64(randomBytes[:]) %
			uint64(jitterLimit+1),
	)
	if delay+jitter > coordinator.maxBackoff {
		return coordinator.maxBackoff
	}
	return delay + jitter
}

// signalModelRefreshQueue 唤醒等待当前 Provider 队列或退避的 worker。
func signalModelRefreshQueue(queue *modelRefreshProviderQueue) {
	close(queue.notify)
	queue.notify = make(chan struct{})
}

// waitForModelRefreshSignal 等待队列变化、退避到期或协调器关闭。
func waitForModelRefreshSignal(
	ctx context.Context,
	notify <-chan struct{},
	delay time.Duration,
) bool {
	if delay <= 0 {
		select {
		case <-ctx.Done():
			return false
		case <-notify:
			return true
		}
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-notify:
		return true
	case <-timer.C:
		return true
	}
}

// validModelRefreshOptions 拒绝未知 Provider、无界并发和不一致退避。
func validModelRefreshOptions(options ModelRefreshCoordinatorOptions) bool {
	if options.Catalog == nil ||
		options.Refresher == nil ||
		options.RefreshTimeout <= 0 ||
		options.BaseBackoff <= 0 ||
		options.MaxBackoff < options.BaseBackoff ||
		options.Clock == nil ||
		options.Random == nil ||
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
