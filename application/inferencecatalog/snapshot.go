package inferencecatalog

import (
	"context"
	"errors"
	"sync/atomic"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/core/inference"
)

var (
	// ErrInvalidAtomicCatalog 表示原子目录缺少有效时钟。
	ErrInvalidAtomicCatalog = errors.New("原子路由目录配置无效")
	// ErrInvalidRouteSnapshot 表示发布对象不是 Builder 创建的完整快照。
	ErrInvalidRouteSnapshot = errors.New("生产路由目录快照无效")
	// ErrRouteCatalogUnavailable 表示首次有效快照尚未发布。
	ErrRouteCatalogUnavailable = errors.New("生产路由目录暂不可用")
)

// Clock 返回目录状态使用的业务时间。
type Clock func() time.Time

// Snapshot 保存同一时刻的模型展示事实和不可变路由解析器。
type Snapshot struct {
	routes     *inferencegateway.RouteCatalog
	models     []accountapp.RoutableModel
	routeCount int
	built      bool
}

// newSnapshot 只供完整 Builder 创建模型与路由一致的快照。
func newSnapshot(
	routes *inferencegateway.RouteCatalog,
	models []accountapp.RoutableModel,
	routeCount int,
) *Snapshot {
	return &Snapshot{
		routes:     routes,
		models:     append([]accountapp.RoutableModel(nil), models...),
		routeCount: routeCount,
		built:      true,
	}
}

// Resolve 使用快照内不可变 RouteCatalog 生成执行计划。
func (snapshot *Snapshot) Resolve(
	ctx context.Context,
	request inference.Request,
) (inferencegateway.RoutePlan, error) {
	if snapshot == nil || !snapshot.isValid() {
		return inferencegateway.RoutePlan{}, ErrInvalidRouteSnapshot
	}
	if ctx == nil {
		return inferencegateway.RoutePlan{}, inferencegateway.ErrInvalidRouteResolution
	}
	if err := ctx.Err(); err != nil {
		return inferencegateway.RoutePlan{}, err
	}
	if snapshot.routes == nil {
		return inferencegateway.RoutePlan{}, inferencegateway.ErrRouteNotFound
	}
	return snapshot.routes.Resolve(ctx, request)
}

// Models 返回不会修改快照内部顺序的模型副本。
func (snapshot *Snapshot) Models() []accountapp.RoutableModel {
	if snapshot == nil || !snapshot.isValid() {
		return nil
	}
	return append([]accountapp.RoutableModel(nil), snapshot.models...)
}

// ModelCount 返回当前对外模型数量。
func (snapshot *Snapshot) ModelCount() int {
	if snapshot == nil || !snapshot.isValid() {
		return 0
	}
	return len(snapshot.models)
}

// RouteCount 返回当前精确模型路由数量。
func (snapshot *Snapshot) RouteCount() int {
	if snapshot == nil || !snapshot.isValid() {
		return 0
	}
	return snapshot.routeCount
}

// isValid 复核空目录或模型与路由数量一致的构造不变量。
func (snapshot *Snapshot) isValid() bool {
	if snapshot == nil ||
		!snapshot.built ||
		snapshot.routeCount < 0 ||
		snapshot.routeCount != len(snapshot.models) {
		return false
	}
	if len(snapshot.models) == 0 {
		return snapshot.routes == nil
	}
	return snapshot.routes != nil
}

// CatalogStatus 是不暴露模型名、账号或内部错误的目录健康快照。
type CatalogStatus struct {
	Ready         bool
	Stale         bool
	ModelCount    int
	RouteCount    int
	LastSuccessAt time.Time
	LastFailureAt time.Time
}

// AtomicCatalog 通过原子指针同时提供路由解析和模型目录读取。
type AtomicCatalog struct {
	clock   Clock
	current atomic.Pointer[Snapshot]
	status  atomic.Pointer[CatalogStatus]
}

// 编译期确认同一生产快照同时满足推理和 /v1/models 读取端口。
var _ inferencegateway.RouteResolver = (*AtomicCatalog)(nil)
var _ inferencegateway.ProtocolRouteResolver = (*AtomicCatalog)(nil)
var _ accountapp.RoutableModelReader = (*AtomicCatalog)(nil)

// NewAtomicCatalog 创建尚未发布快照的失败关闭目录。
func NewAtomicCatalog(clock Clock) (*AtomicCatalog, error) {
	if clock == nil {
		return nil, ErrInvalidAtomicCatalog
	}
	catalog := &AtomicCatalog{clock: clock}
	catalog.status.Store(&CatalogStatus{})
	return catalog, nil
}

// Publish 一次性替换模型和路由，并清除旧 stale 标记。
func (catalog *AtomicCatalog) Publish(snapshot *Snapshot) error {
	if catalog == nil || catalog.clock == nil ||
		snapshot == nil || !snapshot.isValid() {
		return ErrInvalidRouteSnapshot
	}
	observedAt := catalog.clock()
	if !validCatalogTime(observedAt) {
		return ErrInvalidAtomicCatalog
	}
	catalog.current.Store(snapshot)
	catalog.status.Store(&CatalogStatus{
		Ready:         true,
		ModelCount:    snapshot.ModelCount(),
		RouteCount:    snapshot.RouteCount(),
		LastSuccessAt: observedAt,
	})
	return nil
}

// RecordRefreshFailure 保留 last-known-good，只更新低敏健康状态。
func (catalog *AtomicCatalog) RecordRefreshFailure() {
	if catalog == nil || catalog.clock == nil {
		return
	}
	observedAt := catalog.clock()
	if !validCatalogTime(observedAt) {
		return
	}
	previous := catalog.Status()
	previous.Stale = true
	previous.LastFailureAt = observedAt
	catalog.status.Store(&previous)
}

// Resolve 从当前原子快照读取路由，不访问数据库或共享锁。
func (catalog *AtomicCatalog) Resolve(
	ctx context.Context,
	request inference.Request,
) (inferencegateway.RoutePlan, error) {
	if catalog == nil {
		return inferencegateway.RoutePlan{}, ErrRouteCatalogUnavailable
	}
	snapshot := catalog.current.Load()
	if snapshot == nil {
		return inferencegateway.RoutePlan{}, ErrRouteCatalogUnavailable
	}
	return snapshot.Resolve(ctx, request)
}

// ResolveProtocolRoute 从同一个原子快照解析原生线协议路由。
func (catalog *AtomicCatalog) ResolveProtocolRoute(
	ctx context.Context,
	clientProtocol inference.ClientProtocolID,
	model string,
	providerID inference.ProviderID,
	protocolID inference.ProtocolID,
) (inferencegateway.Route, error) {
	if catalog == nil {
		return inferencegateway.Route{}, ErrRouteCatalogUnavailable
	}
	snapshot := catalog.current.Load()
	if snapshot == nil || snapshot.routes == nil || !snapshot.isValid() {
		return inferencegateway.Route{}, ErrRouteCatalogUnavailable
	}
	return snapshot.routes.ResolveProtocolRoute(
		ctx,
		clientProtocol,
		model,
		providerID,
		protocolID,
	)
}

// ListRoutableModels 从当前发布快照返回模型副本。
func (catalog *AtomicCatalog) ListRoutableModels(
	ctx context.Context,
) ([]accountapp.RoutableModel, error) {
	if catalog == nil || ctx == nil {
		return nil, ErrRouteCatalogUnavailable
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	snapshot := catalog.current.Load()
	if snapshot == nil {
		return nil, ErrRouteCatalogUnavailable
	}
	return snapshot.Models(), nil
}

// Status 返回不会与内部状态共享可变内存的健康快照。
func (catalog *AtomicCatalog) Status() CatalogStatus {
	if catalog == nil {
		return CatalogStatus{}
	}
	status := catalog.status.Load()
	if status == nil {
		return CatalogStatus{}
	}
	return *status
}

// validCatalogTime 拒绝无法安全序列化或比较的业务时间。
func validCatalogTime(value time.Time) bool {
	return !value.IsZero() && value.Year() >= 1970 && value.Year() <= 9999
}
