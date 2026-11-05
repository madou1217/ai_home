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
	"sync/atomic"
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
	// 只用于采集方已按自己的代次门禁确认过的快照（见 ReplaceCollectedUsage）。
	ReplaceUsageSnapshot(
		ctx context.Context,
		snapshot usagecore.Snapshot,
	) error
	// ReplaceUsageSnapshotIfCredentialVersion 只在采集使用的凭据仍是当前代次时，
	// 在一个事务中替换同账号的全部当前额度条目。
	ReplaceUsageSnapshotIfCredentialVersion(
		ctx context.Context,
		snapshot usagecore.Snapshot,
		expectedCredentialUpdatedAt time.Time,
	) error
	// GetUsageSnapshot 返回同账号最近一次成功的完整快照。
	GetUsageSnapshot(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (usagecore.Snapshot, error)
}

// UsageDocumentStore 保存采集方生产的完整 Provider 快照文档。
//
// 文档是 WebUI 的直接渲染输入，Go 只校验身份与 JSON 形状，不解释 Provider 字段；
// 归一化的可调度事实仍走 SnapshotStore，两者由同一次采集写入。
type UsageDocumentStore interface {
	// ReplaceUsageDocument 覆盖账号当前文档；更旧的采集时间不得覆盖新文档。
	ReplaceUsageDocument(
		ctx context.Context,
		document usagecore.Document,
	) error
	// ListUsageDocuments 按 Provider / 账号过滤返回文档全集。
	ListUsageDocuments(
		ctx context.Context,
		query DocumentQuery,
	) ([]usagecore.Document, error)
	// ReplaceUsageDocumentQuotaState 更新文档上的物化额度状态。
	ReplaceUsageDocumentQuotaState(
		ctx context.Context,
		state DocumentQuotaState,
	) error
}

// DocumentQuotaState 是物化在快照文档上的账号级额度状态。
type DocumentQuotaState struct {
	AccountRef accountcore.AccountRef
	Status     string
	Reason     string
	Remaining  usagecore.Remaining
}

// DocumentQuery 过滤账号快照文档；空过滤表示全部。
type DocumentQuery struct {
	Providers   []string
	AccountRefs []accountcore.AccountRef
}

// CredentialSnapshotResolver 返回完成必要 OAuth 刷新后的当前凭据快照。
type CredentialSnapshotResolver interface {
	ResolveCredentialSnapshot(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountapp.CredentialSnapshot, error)
}

// AccountModelReader 只读取模型族投影所需的账号模型当前快照。
type AccountModelReader interface {
	ListAccountModels(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) ([]accountapp.AccountModel, error)
}

// RuntimeProjection 原子替换一个账号由 usage 真相源拥有的全部运行态事实。
type RuntimeProjection interface {
	// ReplaceUsageProjection 在一个调用内替换额度阻塞集合与剩余额度权重。
	//
	// remaining 是快照推导出的账号级剩余额度；未知时表示该账号没有额度权重信息，
	// 运行态必须按「无权重」而不是「额度为零」处理。
	ReplaceUsageProjection(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		accountBlocked bool,
		modelIDs []runtimecore.ModelID,
		remaining usagecore.Remaining,
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

// CredentialRefresher 在探测前刷新过期的 OAuth 凭据（可选端口）。
//
// kiro 这类账号的 access token 会过期；额度探测与模型发现共用同一个刷新器，
// 刷新成功后 CAS 落库，探测使用新凭据并沿用新的凭据版本。
type CredentialRefresher interface {
	RefreshCredential(
		ctx context.Context,
		snapshot accountapp.CredentialSnapshot,
	) (accountapp.CredentialSnapshot, error)
}

// ProviderSnapshotStrategy 让策略在一次采集里同时产出展示文档（可选）。
//
// 归一化 Snapshot 只保存路由事实（剩余基点/窗口），WebUI 的 Provider 专属视图
// 需要原始单位（total/used/credits）；放在同一次请求里返回，避免二次采集。
type ProviderSnapshotStrategy interface {
	ProviderStrategy
	FetchUsageWithDocument(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		credential accountapp.Credential,
		capturedAt time.Time,
	) (usagecore.Snapshot, *usagecore.Document, error)
}

// Clock 返回额度采集和陈旧判断使用的业务时间。
type Clock func() time.Time

// Dependencies 集中声明额度服务的细粒度端口。
type Dependencies struct {
	Catalog     *providers.Catalog
	Store       SnapshotStore
	Documents   UsageDocumentStore
	Credentials CredentialSnapshotResolver
	Models      AccountModelReader
	Runtime     RuntimeProjection
	Strategies  []ProviderStrategy
	// Refresher 可选：为需要刷新 OAuth 凭据的 Provider 在探测前续期。
	Refresher CredentialRefresher
	Clock     Clock
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
	documents   UsageDocumentStore
	credentials CredentialSnapshotResolver
	models      AccountModelReader
	runtime     RuntimeProjection
	strategies  map[string]ProviderStrategy
	refresher   CredentialRefresher
	clock       Clock
	flights     refreshFlightGroup
}

// NewService 创建不允许重复 Provider 策略的额度服务。
func NewService(dependencies Dependencies) (*Service, error) {
	if dependencies.Catalog == nil ||
		dependencies.Store == nil ||
		dependencies.Documents == nil ||
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
		documents:   dependencies.Documents,
		credentials: dependencies.Credentials,
		models:      dependencies.Models,
		runtime:     dependencies.Runtime,
		strategies:  strategies,
		clock:       dependencies.Clock,
		flights: refreshFlightGroup{
			active:      make(map[accountcore.AccountRef]*refreshCall),
			generations: make(map[accountcore.AccountRef]*refreshGeneration),
		},
	}, nil
}

// SupportsProvider 判断当前进程是否为规范 Provider 注册了可信额度策略。
// Provider catalog 描述产品能力；实际进程可能分阶段装配更窄的 Strategy 集合，
// 启动恢复和后台调度必须以这里的运行时事实为准。
func (service *Service) SupportsProvider(providerID string) bool {
	if service == nil || service.catalog == nil {
		return false
	}
	canonicalProviderID, found := service.catalog.CanonicalID(providerID)
	return found &&
		canonicalProviderID == providerID &&
		service.strategies[providerID] != nil
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
	return service.flights.Do(ctx, accountRef, func(
		refreshCtx context.Context,
		call *refreshCall,
	) (ReadResult, error) {
		return service.refreshCurrent(refreshCtx, accountRef, call)
	})
}

// ForgetAccount 取消并分离账号当前刷新，同时清除旧额度拥有的运行态阻塞。
func (service *Service) ForgetAccount(
	accountRef accountcore.AccountRef,
) {
	if service == nil || !accountRef.IsValid() {
		return
	}
	_ = service.flights.Forget(accountRef, func() error {
		return service.runtime.ReplaceUsageProjection(
			context.Background(),
			accountRef,
			false,
			nil,
			usagecore.UnknownRemaining(),
		)
	})
}

// refreshCurrent 解析当前凭据、选择 Strategy 并按保存后投影的顺序提交。
func (service *Service) refreshCurrent(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	call *refreshCall,
) (ReadResult, error) {
	credentialSnapshot, err := service.credentials.ResolveCredentialSnapshot(
		ctx,
		accountRef,
	)
	if err != nil {
		return ReadResult{}, err
	}
	if !credentialSnapshot.IsValid() ||
		credentialSnapshot.AccountRef() != accountRef {
		return ReadResult{}, ErrInvalidSnapshot
	}
	// 过期的 OAuth 凭据先刷新：刷新的 CAS 版本同时用于后面的快照写入。
	if service.refresher != nil {
		refreshed, refreshErr := service.refresher.RefreshCredential(ctx, credentialSnapshot)
		if refreshErr != nil {
			return ReadResult{}, refreshErr
		}
		if !refreshed.IsValid() || refreshed.AccountRef() != accountRef {
			return ReadResult{}, ErrInvalidSnapshot
		}
		credentialSnapshot = refreshed
	}
	credential := credentialSnapshot.Credential()
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
	var (
		snapshot usagecore.Snapshot
		document *usagecore.Document
	)
	if extended, ok := strategy.(ProviderSnapshotStrategy); ok {
		snapshot, document, err = extended.FetchUsageWithDocument(
			ctx,
			accountRef,
			credential,
			capturedAt,
		)
	} else {
		snapshot, err = strategy.FetchUsage(
			ctx,
			accountRef,
			credential,
			capturedAt,
		)
	}
	if err != nil {
		return ReadResult{}, err
	}
	if !snapshot.IsValid() ||
		snapshot.AccountRef() != accountRef ||
		snapshot.ProviderID() != providerID ||
		!snapshot.CapturedAt().Equal(capturedAt) {
		return ReadResult{}, ErrInvalidSnapshot
	}
	if err := service.store.ReplaceUsageSnapshotIfCredentialVersion(
		ctx,
		snapshot,
		credentialSnapshot.UpdatedAt(),
	); err != nil {
		return ReadResult{}, err
	}
	// 展示文档与归一化事实同源同刻：先落文档，再刷新物化额度状态。
	if document != nil {
		if err := service.ReplaceDocument(ctx, *document); err != nil {
			return ReadResult{}, err
		}
	}
	if call == nil {
		return ReadResult{}, ErrInvalidRequest
	}
	if err := call.project(func() error {
		return service.projectRuntime(
			context.WithoutCancel(ctx),
			snapshot,
			strategy,
		)
	}); err != nil {
		if errors.Is(err, context.Canceled) {
			return ReadResult{}, err
		}
		return ReadResult{}, errors.Join(ErrRuntimeProjection, err)
	}
	return NewReadResult(snapshot, false)
}

// ReplaceUsageSnapshot 接受外部采集的完整额度快照，按当前凭据代次 CAS 落库，
// 并在提交后投影运行态阻塞。Node 的 quota 探测迁入 Go 时走这个入口。
func (service *Service) ReplaceUsage(
	ctx context.Context,
	snapshot usagecore.Snapshot,
) error {
	if service == nil ||
		service.store == nil ||
		service.credentials == nil ||
		ctx == nil ||
		!snapshot.IsValid() {
		return ErrInvalidRequest
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	credentialSnapshot, err := service.credentials.ResolveCredentialSnapshot(
		ctx,
		snapshot.AccountRef(),
	)
	if err != nil {
		return err
	}
	if !credentialSnapshot.IsValid() ||
		credentialSnapshot.AccountRef() != snapshot.AccountRef() ||
		credentialSnapshot.Credential().ProviderID() != snapshot.ProviderID() {
		return ErrInvalidSnapshot
	}
	if err := service.store.ReplaceUsageSnapshotIfCredentialVersion(
		ctx,
		snapshot,
		credentialSnapshot.UpdatedAt(),
	); err != nil {
		return err
	}
	if strategy := service.strategies[snapshot.ProviderID()]; strategy != nil {
		if err := service.projectRuntime(ctx, snapshot, strategy); err != nil {
			return err
		}
	}
	return service.refreshDocumentQuotaState(ctx, snapshot.AccountRef())
}

// ReplaceCollectedUsage 保存采集方已确认的归一化额度快照。
//
// 与 ReplaceUsage 的差异：不要求 Go 能解析该账号的当前凭据。采集方（Node）在写入前
// 已用自有的凭据代次门禁排除了过期快照；Go 只做账号存在性与 Provider 一致性校验。
// Go 自己的探针路径仍走 ReplaceUsage 的凭据 CAS。
func (service *Service) ReplaceCollectedUsage(
	ctx context.Context,
	snapshot usagecore.Snapshot,
) error {
	if service == nil || service.store == nil || ctx == nil || !snapshot.IsValid() {
		return ErrInvalidRequest
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := service.store.ReplaceUsageSnapshot(ctx, snapshot); err != nil {
		return err
	}
	if strategy := service.strategies[snapshot.ProviderID()]; strategy != nil {
		if err := service.projectRuntime(ctx, snapshot, strategy); err != nil {
			return err
		}
	}
	return service.refreshDocumentQuotaState(ctx, snapshot.AccountRef())
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
		snapshot.MinRemaining(),
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
	done             chan struct{}
	cancel           context.CancelFunc
	generation       *refreshGeneration
	generationNumber uint64
	result           ReadResult
	err              error
}

// refreshGeneration 串行化同账号的代次切换与最终运行态投影。
type refreshGeneration struct {
	projectionMu sync.Mutex
	number       atomic.Uint64
}

// refreshFlightGroup 只合并活动刷新，不缓存完成结果。
type refreshFlightGroup struct {
	mu          sync.Mutex
	active      map[accountcore.AccountRef]*refreshCall
	generations map[accountcore.AccountRef]*refreshGeneration
}

// Do 让首个调用执行刷新，其余调用等待同一个确定性结果。
func (group *refreshFlightGroup) Do(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	operation func(context.Context, *refreshCall) (ReadResult, error),
) (ReadResult, error) {
	group.mu.Lock()
	if call := group.active[accountRef]; call != nil {
		group.mu.Unlock()
		return waitForRefresh(ctx, call)
	}
	operationCtx, cancel := context.WithCancel(ctx)
	generation := group.generations[accountRef]
	if generation == nil {
		generation = &refreshGeneration{}
		group.generations[accountRef] = generation
	}
	call := &refreshCall{
		done:             make(chan struct{}),
		cancel:           cancel,
		generation:       generation,
		generationNumber: generation.number.Load(),
	}
	group.active[accountRef] = call
	group.mu.Unlock()

	call.result, call.err = operation(operationCtx, call)
	cancel()
	group.mu.Lock()
	if group.active[accountRef] == call {
		delete(group.active, accountRef)
	}
	close(call.done)
	group.mu.Unlock()
	return call.result, call.err
}

// Forget 切换账号代次，在同一投影门禁内清理旧状态，并取消旧活动请求。
func (group *refreshFlightGroup) Forget(
	accountRef accountcore.AccountRef,
	cleanup func() error,
) error {
	if group == nil ||
		group.active == nil ||
		group.generations == nil ||
		!accountRef.IsValid() ||
		cleanup == nil {
		return ErrInvalidRequest
	}
	group.mu.Lock()
	generation := group.generations[accountRef]
	if generation == nil {
		generation = &refreshGeneration{}
		group.generations[accountRef] = generation
	}
	group.mu.Unlock()

	generation.projectionMu.Lock()
	defer generation.projectionMu.Unlock()
	nextGeneration := generation.number.Add(1)
	group.mu.Lock()
	call := group.active[accountRef]
	if call != nil && call.generationNumber < nextGeneration {
		delete(group.active, accountRef)
	} else {
		call = nil
	}
	group.mu.Unlock()
	if call != nil && call.cancel != nil {
		call.cancel()
	}
	return cleanup()
}

// project 只允许仍属于当前账号代次的任务修改 usage 运行态投影。
func (call *refreshCall) project(operation func() error) error {
	if call == nil || operation == nil {
		return ErrInvalidRequest
	}
	if call.generation == nil {
		return ErrInvalidRequest
	}
	call.generation.projectionMu.Lock()
	defer call.generation.projectionMu.Unlock()
	if call.generation.number.Load() != call.generationNumber {
		return context.Canceled
	}
	return operation()
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
