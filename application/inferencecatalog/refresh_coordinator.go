package inferencecatalog

import (
	"context"
	"errors"
	"sync"
)

var (
	// ErrInvalidRefreshCoordinator 表示刷新协调器缺少 Builder 或原子目录。
	ErrInvalidRefreshCoordinator = errors.New("生产路由目录刷新协调器配置无效")
)

// SnapshotBuilder 是异步刷新所需的最小构建端口。
type SnapshotBuilder interface {
	Build(ctx context.Context) (*Snapshot, error)
}

// RefreshCoordinatorOptions 声明目录刷新协调器的最小依赖。
type RefreshCoordinatorOptions struct {
	Builder SnapshotBuilder
	Catalog *AtomicCatalog
}

// RefreshCoordinator 使用单 worker 和容量一信号合并目录刷新风暴。
type RefreshCoordinator struct {
	builder   SnapshotBuilder
	catalog   *AtomicCatalog
	ctx       context.Context
	cancel    context.CancelFunc
	signal    chan struct{}
	buildMu   sync.Mutex
	closeOnce sync.Once
	worker    sync.WaitGroup
}

// NewRefreshCoordinator 创建并启动唯一目录刷新 worker。
func NewRefreshCoordinator(
	options RefreshCoordinatorOptions,
) (*RefreshCoordinator, error) {
	if options.Builder == nil || options.Catalog == nil {
		return nil, ErrInvalidRefreshCoordinator
	}
	ctx, cancel := context.WithCancel(context.Background())
	coordinator := &RefreshCoordinator{
		builder: options.Builder,
		catalog: options.Catalog,
		ctx:     ctx,
		cancel:  cancel,
		signal:  make(chan struct{}, 1),
	}
	coordinator.worker.Add(1)
	go coordinator.run()
	return coordinator, nil
}

// Refresh 同步构建并发布一次完整快照，供 Host 初始化和确定性测试使用。
func (coordinator *RefreshCoordinator) Refresh(ctx context.Context) error {
	if coordinator == nil ||
		coordinator.builder == nil ||
		coordinator.catalog == nil ||
		ctx == nil {
		return ErrInvalidRefreshCoordinator
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	coordinator.buildMu.Lock()
	defer coordinator.buildMu.Unlock()
	snapshot, err := coordinator.builder.Build(ctx)
	if err != nil {
		coordinator.catalog.RecordRefreshFailure()
		return err
	}
	if err := coordinator.catalog.Publish(snapshot); err != nil {
		coordinator.catalog.RecordRefreshFailure()
		return err
	}
	return nil
}

// RoutableModelsChanged 合并账号写路径产生的模型目录变化通知。
func (coordinator *RefreshCoordinator) RoutableModelsChanged() {
	if coordinator == nil {
		return
	}
	select {
	case <-coordinator.ctx.Done():
		return
	default:
	}
	select {
	case coordinator.signal <- struct{}{}:
	default:
	}
}

// Close 停止接收刷新并等待唯一 worker 退出。
func (coordinator *RefreshCoordinator) Close() error {
	if coordinator == nil {
		return nil
	}
	coordinator.closeOnce.Do(func() {
		coordinator.cancel()
		coordinator.worker.Wait()
	})
	return nil
}

// run 串行消费合并信号；刷新失败由状态记录，后续变化仍可恢复。
func (coordinator *RefreshCoordinator) run() {
	defer coordinator.worker.Done()
	for {
		select {
		case <-coordinator.ctx.Done():
			return
		case <-coordinator.signal:
			_ = coordinator.Refresh(coordinator.ctx)
		}
	}
}
