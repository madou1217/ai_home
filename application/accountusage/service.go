// Package accountusage 编排账号当前额度的读取、Provider 刷新和运行态投影。
//
// 该应用层只依赖凭据、当前快照存储、账号模型查询和 Provider Strategy，
// 不认识 SQLite、HTTP 路由或 Provider 原始 JSON。
package accountusage

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
	"github.com/madou1217/ai_home/core/providers"
)

const (
	// DefaultFreshness 是管理 API 判断当前快照是否陈旧的固定时长。
	DefaultFreshness = 5 * time.Minute
)

var (
	// ErrInvalidDependencies 表示额度服务缺少存储、凭据、模型、运行态、时钟或策略。
	ErrInvalidDependencies = errors.New("账号额度服务依赖无效")
	// ErrInvalidRequest 表示上下文或账号身份无效。
	ErrInvalidRequest = errors.New("账号额度请求无效")
	// ErrSnapshotNotFound 表示账号还没有任何成功额度快照。
	ErrSnapshotNotFound = errors.New("账号额度快照不存在")
	// ErrUsageUnsupported 表示当前 Provider 或凭据类型没有可信额度接口。
	ErrUsageUnsupported = errors.New("账号凭据不支持额度刷新")
	// ErrRefreshFailed 表示 Provider 请求或响应解码失败。
	ErrRefreshFailed = errors.New("账号额度刷新失败")
	// ErrInvalidSnapshot 表示 Adapter 或存储返回了身份不一致的额度快照。
	ErrInvalidSnapshot = errors.New("账号额度快照结果无效")
	// ErrRuntimeProjection 表示快照已保存但运行态投影没有完成。
	ErrRuntimeProjection = errors.New("账号额度运行态投影失败")
)

// SnapshotStore 提供账号当前额度的原子全量替换和点查。
type SnapshotStore interface {
	// ReplaceUsageSnapshot 在一个事务中替换同账号的全部当前额度条目。
	ReplaceUsageSnapshot(ctx context.Context, snapshot usagecore.Snapshot) error
	// GetUsageSnapshot 返回同账号最近一次成功的完整快照。
	GetUsageSnapshot(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (usagecore.Snapshot, error)
}

// CredentialResolver 返回已经完成必要 OAuth 刷新的当前凭据。
type CredentialResolver interface {
	ResolveCredential(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountapp.Credential, error)
}

// AccountModelReader 只读取模型族投影所需的账号模型当前快照。
type AccountModelReader interface {
	ListAccountModels(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) ([]accountapp.AccountModel, error)
}

// RuntimeProjection 原子替换一个账号由 usage 真相源拥有的阻塞集合。
type RuntimeProjection interface {
	ReplaceUsageProjection(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		accountBlocked bool,
		modelIDs []runtimecore.ModelID,
	) error
}

// ProviderStrategy 隔离一个 Provider 的额度协议与模型族命名事实。
type ProviderStrategy interface {
	// ProviderID 返回策略唯一支持的规范 Provider。
	ProviderID() string
	// FetchUsage 使用领域凭据读取并归一化完整当前快照。
	FetchUsage(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		credential accountapp.Credential,
		capturedAt time.Time,
	) (usagecore.Snapshot, error)
	// MatchesModelFamily 判断真实模型是否属于 Provider 返回的模型族。
	MatchesModelFamily(scopeKey string, modelID runtimecore.ModelID) bool
}

// Clock 返回额度采集和陈旧判断使用的业务时间。
type Clock func() time.Time

// Dependencies 集中声明额度服务的细粒度端口。
type Dependencies struct {
	Catalog     *providers.Catalog
	Store       SnapshotStore
	Credentials CredentialResolver
	Models      AccountModelReader
	Runtime     RuntimeProjection
	Strategies  []ProviderStrategy
	Clock       Clock
}

// ReadResult 是管理 API 读取的当前快照和陈旧状态。
type ReadResult struct {
	snapshot usagecore.Snapshot
	stale    bool
}

// NewReadResult 创建供入站适配器测试和组合层传递的已校验读取结果。
func NewReadResult(
	snapshot usagecore.Snapshot,
	stale bool,
) (ReadResult, error) {
	if !snapshot.IsValid() {
		return ReadResult{}, ErrInvalidSnapshot
	}
	return ReadResult{snapshot: snapshot, stale: stale}, nil
}

// Snapshot 返回不可变额度快照的值副本。
func (result ReadResult) Snapshot() usagecore.Snapshot {
	return result.snapshot
}

// Stale 表示快照采集时间已经超过固定新鲜度。
func (result ReadResult) Stale() bool {
	return result.stale
}

// Service 使用 Strategy 注册表执行账号级额度用例。
type Service struct {
	catalog     *providers.Catalog
	store       SnapshotStore
	credentials CredentialResolver
	models      AccountModelReader
	runtime     RuntimeProjection
	strategies  map[string]ProviderStrategy
	clock       Clock
	flights     refreshFlightGroup
}

// NewService 创建不允许重复 Provider 策略的额度服务。
func NewService(dependencies Dependencies) (*Service, error) {
	if dependencies.Catalog == nil ||
		dependencies.Store == nil ||
		dependencies.Credentials == nil ||
		dependencies.Models == nil ||
		dependencies.Runtime == nil ||
		dependencies.Clock == nil ||
		len(dependencies.Strategies) == 0 {
		return nil, ErrInvalidDependencies
	}
	strategies := make(map[string]ProviderStrategy, len(dependencies.Strategies))
	for _, strategy := range dependencies.Strategies {
		if strategy == nil {
			return nil, ErrInvalidDependencies
		}
		providerID, found := dependencies.Catalog.CanonicalID(strategy.ProviderID())
		if !found ||
			providerID != strategy.ProviderID() ||
			strategies[providerID] != nil {
			return nil, ErrInvalidDependencies
		}
		strategies[providerID] = strategy
	}
	return &Service{
		catalog:     dependencies.Catalog,
		store:       dependencies.Store,
		credentials: dependencies.Credentials,
		models:      dependencies.Models,
		runtime:     dependencies.Runtime,
		strategies:  strategies,
		clock:       dependencies.Clock,
		flights: refreshFlightGroup{
			active: make(map[accountcore.AccountRef]*refreshCall),
		},
	}, nil
}

// GetUsage 返回最近一次成功快照；读取不会隐式访问上游。
func (service *Service) GetUsage(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (ReadResult, error) {
	if err := service.validateRequest(ctx, accountRef); err != nil {
		return ReadResult{}, err
	}
	snapshot, err := service.store.GetUsageSnapshot(ctx, accountRef)
	if err != nil {
		return ReadResult{}, err
	}
	if !snapshot.IsValid() || snapshot.AccountRef() != accountRef {
		return ReadResult{}, ErrInvalidSnapshot
	}
	now, err := service.currentTime()
	if err != nil {
		return ReadResult{}, err
	}
	return NewReadResult(
		snapshot,
		!snapshot.CapturedAt().Add(DefaultFreshness).After(now),
	)
}

// RestoreUsageProjection 从持久化 last-known-good 恢复进程内 quota block，不访问上游。
func (service *Service) RestoreUsageProjection(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) error {
	if err := service.validateRequest(ctx, accountRef); err != nil {
		return err
	}
	snapshot, err := service.store.GetUsageSnapshot(ctx, accountRef)
	if err != nil {
		return err
	}
	if !snapshot.IsValid() || snapshot.AccountRef() != accountRef {
		return ErrInvalidSnapshot
	}
	strategy := service.strategies[snapshot.ProviderID()]
	if strategy == nil {
		return ErrUsageUnsupported
	}
	return service.projectRuntime(ctx, snapshot, strategy)
}

// RefreshUsage 合并同账号并发请求并保存完整 last-known-good 快照。
func (service *Service) RefreshUsage(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (ReadResult, error) {
	if err := service.validateRequest(ctx, accountRef); err != nil {
		return ReadResult{}, err
	}
	return service.flights.Do(ctx, accountRef, func() (ReadResult, error) {
		return service.refreshCurrent(ctx, accountRef)
	})
}

// refreshCurrent 解析当前凭据、选择 Strategy 并按保存后投影的顺序提交。
func (service *Service) refreshCurrent(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (ReadResult, error) {
	credential, err := service.credentials.ResolveCredential(ctx, accountRef)
	if err != nil {
		return ReadResult{}, err
	}
	if credential == nil {
		return ReadResult{}, ErrUsageUnsupported
	}
	derivedRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil || derivedRef != accountRef {
		return ReadResult{}, ErrInvalidSnapshot
	}
	providerID, found := service.catalog.CanonicalID(credential.ProviderID())
	if !found || providerID != credential.ProviderID() {
		return ReadResult{}, ErrInvalidSnapshot
	}
	strategy := service.strategies[providerID]
	if strategy == nil {
		return ReadResult{}, ErrUsageUnsupported
	}
	capturedAt, err := service.currentTime()
	if err != nil {
		return ReadResult{}, err
	}
	snapshot, err := strategy.FetchUsage(
		ctx,
		accountRef,
		credential,
		capturedAt,
	)
	if err != nil {
		return ReadResult{}, err
	}
	if !snapshot.IsValid() ||
		snapshot.AccountRef() != accountRef ||
		snapshot.ProviderID() != providerID ||
		!snapshot.CapturedAt().Equal(capturedAt) {
		return ReadResult{}, ErrInvalidSnapshot
	}
	if err := service.store.ReplaceUsageSnapshot(ctx, snapshot); err != nil {
		return ReadResult{}, err
	}
	if err := service.projectRuntime(
		context.WithoutCancel(ctx),
		snapshot,
		strategy,
	); err != nil {
		return ReadResult{}, errors.Join(ErrRuntimeProjection, err)
	}
	return NewReadResult(snapshot, false)
}

// projectRuntime 只把明确耗尽的窗口投影为账号或模型族 quota block。
func (service *Service) projectRuntime(
	ctx context.Context,
	snapshot usagecore.Snapshot,
	strategy ProviderStrategy,
) error {
	accountBlocked := false
	families := make(map[string]struct{})
	for _, entry := range snapshot.Entries() {
		if entry.Kind() != usagecore.KindWindow ||
			entry.Availability() != usagecore.AvailabilityExhausted {
			continue
		}
		if entry.Scope() == usagecore.ScopeAccount {
			accountBlocked = true
			continue
		}
		families[entry.ScopeKey()] = struct{}{}
	}

	var blockedModels []runtimecore.ModelID
	if len(families) > 0 {
		models, err := service.models.ListAccountModels(ctx, snapshot.AccountRef())
		if err != nil {
			return err
		}
		effective, err := accountapp.EffectiveModelIDs(models)
		if err != nil {
			return ErrInvalidSnapshot
		}
		for _, modelID := range effective {
			for family := range families {
				if strategy.MatchesModelFamily(family, modelID) {
					blockedModels = append(blockedModels, modelID)
					break
				}
			}
		}
		sort.Slice(blockedModels, func(left int, right int) bool {
			return blockedModels[left].String() < blockedModels[right].String()
		})
	}
	return service.runtime.ReplaceUsageProjection(
		ctx,
		snapshot.AccountRef(),
		accountBlocked,
		blockedModels,
	)
}

// currentTime 返回 UTC 毫秒精度的可持久化时钟值。
func (service *Service) currentTime() (time.Time, error) {
	now := service.clock()
	if now.IsZero() || now.UnixMilli() < 0 || now.Year() > 9999 {
		return time.Time{}, ErrInvalidDependencies
	}
	return time.UnixMilli(now.UnixMilli()).UTC(), nil
}

// validateRequest 在访问凭据、数据库或运行态前拒绝无效输入。
func (service *Service) validateRequest(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) error {
	if service == nil ||
		service.catalog == nil ||
		service.store == nil ||
		service.credentials == nil ||
		service.models == nil ||
		service.runtime == nil ||
		service.clock == nil ||
		service.strategies == nil ||
		ctx == nil ||
		!accountRef.IsValid() {
		return ErrInvalidRequest
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return nil
}

// refreshCall 保存同账号正在执行的唯一刷新结果。
type refreshCall struct {
	done   chan struct{}
	result ReadResult
	err    error
}

// refreshFlightGroup 只合并活动刷新，不缓存完成结果。
type refreshFlightGroup struct {
	mu     sync.Mutex
	active map[accountcore.AccountRef]*refreshCall
}

// Do 让首个调用执行刷新，其余调用等待同一个确定性结果。
func (group *refreshFlightGroup) Do(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	operation func() (ReadResult, error),
) (ReadResult, error) {
	group.mu.Lock()
	if call := group.active[accountRef]; call != nil {
		group.mu.Unlock()
		return waitForRefresh(ctx, call)
	}
	call := &refreshCall{done: make(chan struct{})}
	group.active[accountRef] = call
	group.mu.Unlock()

	call.result, call.err = operation()
	group.mu.Lock()
	delete(group.active, accountRef)
	close(call.done)
	group.mu.Unlock()
	return call.result, call.err
}

// waitForRefresh 允许等待者独立取消，不终止已经发出的 Provider 请求。
func waitForRefresh(
	ctx context.Context,
	call *refreshCall,
) (ReadResult, error) {
	select {
	case <-ctx.Done():
		return ReadResult{}, ctx.Err()
	case <-call.done:
		return call.result, call.err
	}
}
