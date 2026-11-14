package accounts

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
)

var (
	// ErrInvalidModelDiscoveryDependencies 表示发现注册表缺少 Provider 或策略。
	ErrInvalidModelDiscoveryDependencies = errors.New("账号模型发现依赖无效")
	// ErrModelDiscoveryUnsupported 表示账号 Provider 没有模型发现策略。
	ErrModelDiscoveryUnsupported = errors.New("账号 Provider 不支持模型发现")
	// ErrModelDiscoveryFailed 表示 Provider 目录请求或解码没有成功。
	ErrModelDiscoveryFailed = errors.New("账号模型发现失败")
	// ErrInvalidModelManagementDependencies 表示模型管理缺少凭据、存储、发现或时钟。
	ErrInvalidModelManagementDependencies = errors.New("账号模型管理依赖无效")
)

// ProviderModelDiscoverer 是一个 Provider 的远端模型目录写侧适配器。
//
// 该端口只允许账号管理用例调用，不能注入 Recruiter 或本地 /v1/models。
type ProviderModelDiscoverer interface {
	// ProviderID 返回该策略唯一支持的规范 Provider。
	ProviderID() string
	// DiscoverModels 读取给定凭据当前可见的完整模型目录。
	DiscoverModels(
		ctx context.Context,
		credential Credential,
	) ([]string, error)
}

// ModelDiscovery 按 Provider 选择唯一模型发现策略。
type ModelDiscovery struct {
	catalog    *providers.Catalog
	strategies map[string]ProviderModelDiscoverer
}

// NewModelDiscovery 创建不允许重复 Provider 策略的发现注册表。
func NewModelDiscovery(
	catalog *providers.Catalog,
	strategies []ProviderModelDiscoverer,
) (*ModelDiscovery, error) {
	if catalog == nil || len(strategies) == 0 {
		return nil, ErrInvalidModelDiscoveryDependencies
	}
	indexed := make(map[string]ProviderModelDiscoverer, len(strategies))
	for _, strategy := range strategies {
		if strategy == nil {
			return nil, ErrInvalidModelDiscoveryDependencies
		}
		providerID, found := catalog.CanonicalID(strategy.ProviderID())
		if !found ||
			providerID != strategy.ProviderID() ||
			indexed[providerID] != nil {
			return nil, ErrInvalidModelDiscoveryDependencies
		}
		indexed[providerID] = strategy
	}
	return &ModelDiscovery{catalog: catalog, strategies: indexed}, nil
}

// ProviderIDs 返回注册了发现策略的 Provider 集合（升序快照）。
//
// 供装配自检与守卫测试比对「有发现策略的 Provider」与「有刷新队列的 Provider」：
// 两者不一致时的表现是静默的（账号永远不会被扫描刷新，模型目录一直为空）。
func (discovery *ModelDiscovery) ProviderIDs() []string {
	if discovery == nil {
		return nil
	}
	providers := make([]string, 0, len(discovery.strategies))
	for providerID := range discovery.strategies {
		providers = append(providers, providerID)
	}
	sort.Strings(providers)
	return providers
}

// DiscoverModels 执行 Provider 策略并规范化完整模型集合。
func (discovery *ModelDiscovery) DiscoverModels(
	ctx context.Context,
	credential Credential,
) ([]runtimecore.ModelID, error) {
	if discovery == nil ||
		discovery.catalog == nil ||
		ctx == nil ||
		credential == nil {
		return nil, ErrInvalidModelDiscoveryDependencies
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	providerID, found := discovery.catalog.CanonicalID(credential.ProviderID())
	if !found || providerID != credential.ProviderID() {
		return nil, ErrInvalidModelDiscoveryDependencies
	}
	strategy := discovery.strategies[providerID]
	if strategy == nil {
		return nil, ErrModelDiscoveryUnsupported
	}
	values, err := strategy.DiscoverModels(ctx, credential)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrModelDiscoveryFailed, err)
	}
	return NormalizeDiscoveredModels(values)
}

// ModelCredentialRefresher 在模型发现前把过期的 OAuth 凭据刷新并 CAS 落库。
//
// 可选端口：装配为 nil 时表示该部署不做凭据刷新（例如只读预览）。
type ModelCredentialRefresher interface {
	RefreshCredential(
		ctx context.Context,
		snapshot CredentialSnapshot,
	) (CredentialSnapshot, error)
}

// AccountCredentialSnapshotReader 是模型刷新读取当前规范凭据及 CAS 版本的最小端口。
type AccountCredentialSnapshotReader interface {
	GetCredentialSnapshot(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (CredentialSnapshot, error)
}

// ModelManagement 编排查询、人工维护和显式远端刷新。
type ModelManagement struct {
	credentials AccountCredentialSnapshotReader
	models      AccountModelStore
	discovery   *ModelDiscovery
	refresher   ModelCredentialRefresher
	probes      ModelProbeRecorder
	clock       Clock
	// routable 是本地可路由目录；只用于网关账号（自定义 base_url）的动态目录并集。
	routable RoutableModelSource
}

// RoutableModelSource 返回本地当前可路由的模型集合（Provider + 模型）。
type RoutableModelSource interface {
	ListRoutableModels(ctx context.Context) ([]RoutableModel, error)
}

// SetRoutableModelSource 注入本地目录来源；nil 表示不做网关账号并集。
//
// 网关账号（例如指向自建 Proxy 的 codex API Key 账号）的上游 /models 只是它
// 自己的快照；本地新发现的模型（agy 档位别名）不应等到代理升级或 6 小时重扫
// 才出现，因此刷新时把本地可路由目录并入。
func (management *ModelManagement) SetRoutableModelSource(source RoutableModelSource) {
	if management == nil {
		return
	}
	management.routable = source
}

// NewModelManagement 创建只用于账号管理写路径的模型用例。
func NewModelManagement(
	credentials AccountCredentialSnapshotReader,
	models AccountModelStore,
	discovery *ModelDiscovery,
	refresher ModelCredentialRefresher,
	probes ModelProbeRecorder,
	clock Clock,
) (*ModelManagement, error) {
	if credentials == nil ||
		models == nil ||
		discovery == nil ||
		probes == nil ||
		clock == nil {
		return nil, ErrInvalidModelManagementDependencies
	}
	return &ModelManagement{
		credentials: credentials,
		models:      models,
		discovery:   discovery,
		refresher:   refresher,
		probes:      probes,
		clock:       clock,
	}, nil
}

// mergeGatewayModels 把本地可路由目录并入网关账号的发现结果。
//
// 只对「凭据带自定义 base_url」的账号生效：官方 endpoint 的账号目录必须严格等于
// 上游返回，不能把本地模型塞给不认识它们的上游。并集按模型 ID 去重并排序。
func (management *ModelManagement) mergeGatewayModels(
	ctx context.Context,
	credential Credential,
	modelIDs []runtimecore.ModelID,
) []runtimecore.ModelID {
	return management.mergeRoutableModels(ctx, gatewayBaseURL(credential), modelIDs)
}

// mergeRoutableModels 是 mergeGatewayModels 的可测试实现：baseURL 为空表示官方账号。
func (management *ModelManagement) mergeRoutableModels(
	ctx context.Context,
	baseURL string,
	modelIDs []runtimecore.ModelID,
) []runtimecore.ModelID {
	if management == nil || management.routable == nil || ctx == nil || baseURL == "" {
		return modelIDs
	}
	models, err := management.routable.ListRoutableModels(ctx)
	if err != nil || len(models) == 0 {
		return modelIDs
	}
	seen := make(map[runtimecore.ModelID]struct{}, len(modelIDs)+len(models))
	merged := make([]runtimecore.ModelID, 0, len(modelIDs)+len(models))
	for _, modelID := range modelIDs {
		if _, found := seen[modelID]; found {
			continue
		}
		seen[modelID] = struct{}{}
		merged = append(merged, modelID)
	}
	for _, model := range models {
		modelID := model.ModelID()
		if !modelID.IsValid() {
			continue
		}
		if _, found := seen[modelID]; found {
			continue
		}
		seen[modelID] = struct{}{}
		merged = append(merged, modelID)
	}
	sort.Slice(merged, func(left, right int) bool {
		return merged[left].String() < merged[right].String()
	})
	return merged
}

// gatewayBaseURL 返回自定义上游地址；官方默认地址返回空串。
func gatewayBaseURL(credential any) string {
	type endpointCredential interface {
		BaseURL() string
	}
	value, ok := credential.(endpointCredential)
	if !ok {
		return ""
	}
	baseURL := strings.TrimRight(strings.TrimSpace(value.BaseURL()), "/")
	if baseURL == "" || baseURL == strings.TrimRight(codex.DefaultAPIBaseURL, "/") {
		return ""
	}
	return baseURL
}

// ListAccountModels 返回账号当前自动发现与人工策略快照。
func (management *ModelManagement) ListAccountModels(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) ([]AccountModel, error) {
	if management == nil || !accountRef.IsValid() {
		return nil, ErrInvalidAccountModel
	}
	return management.models.ListAccountModels(ctx, accountRef)
}

// RefreshAccountModelSnapshot 读取当前凭据并全量刷新上游发现部分。
//
// 这是唯一真正执行 DiscoverModels 的位置，因此也在这里记录探测事实：成功的目录
// 替换提交后写 remote 与模型数；任何一步失败都写 error 事实。用独立事实表记录是
// 因为失败时目录快照保持不变，只有探测表能表达「最近一次尝试失败了」。
func (management *ModelManagement) RefreshAccountModelSnapshot(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (AccountModelRefreshSnapshot, error) {
	if management == nil || ctx == nil || !accountRef.IsValid() {
		return AccountModelRefreshSnapshot{AccountRef: accountRef}, ErrInvalidAccountModel
	}
	credentialSnapshot, err := management.credentials.GetCredentialSnapshot(
		ctx,
		accountRef,
	)
	if err != nil {
		management.recordModelProbeFailure(ctx, accountRef, err, time.Time{})
		return AccountModelRefreshSnapshot{AccountRef: accountRef}, err
	}
	if !credentialSnapshot.IsValid() ||
		credentialSnapshot.AccountRef() != accountRef {
		err = ErrInvalidAccountModel
		management.recordModelProbeFailure(ctx, accountRef, err, time.Time{})
		return AccountModelRefreshSnapshot{AccountRef: accountRef}, err
	}
	// kiro 这类 OAuth 账号的 access token 会过期；先刷新再发现，否则上游直接 403。
	if management.refresher != nil {
		refreshed, refreshErr := management.refresher.RefreshCredential(ctx, credentialSnapshot)
		if refreshErr != nil {
			management.recordModelProbeFailure(ctx, accountRef, refreshErr, credentialSnapshot.UpdatedAt())
			return AccountModelRefreshSnapshot{AccountRef: accountRef}, refreshErr
		}
		if !refreshed.IsValid() || refreshed.ProviderID() != credentialSnapshot.ProviderID() {
			management.recordModelProbeFailure(ctx, accountRef, ErrInvalidCredentialSnapshot, credentialSnapshot.UpdatedAt())
			return AccountModelRefreshSnapshot{AccountRef: accountRef}, ErrInvalidCredentialSnapshot
		}
		credentialSnapshot = refreshed
	}
	// 刷新可能把账号迁移到新的稳定身份（re-key）：后续的模型、探测事实必须落在
	// 新 AccountRef 上，否则会写回已删除的旧账号。
	if credentialSnapshot.AccountRef() != accountRef {
		accountRef = credentialSnapshot.AccountRef()
	}
	discovered, credentialSnapshot, err := management.discoverWithCredentialRecovery(ctx, credentialSnapshot)
	// 恢复也可能 re-key；目录 CAS 与探测事实必须使用恢复后的身份和代次。
	if credentialSnapshot.IsValid() {
		accountRef = credentialSnapshot.AccountRef()
	}
	if err != nil {
		management.recordModelProbeFailure(ctx, accountRef, err, credentialSnapshot.UpdatedAt())
		return AccountModelRefreshSnapshot{AccountRef: accountRef}, err
	}
	discovered = management.mergeGatewayModels(
		ctx,
		credentialSnapshot.Credential(),
		discovered,
	)
	updatedAt, err := normalizeModelTime(management.clock())
	if err != nil {
		management.recordModelProbeFailure(ctx, accountRef, err, credentialSnapshot.UpdatedAt())
		return AccountModelRefreshSnapshot{AccountRef: accountRef}, err
	}
	snapshot, err := management.models.ReplaceDiscoveredModelsIfCredentialVersion(
		ctx,
		accountRef,
		discovered,
		credentialSnapshot.UpdatedAt(),
		updatedAt,
	)
	if err != nil {
		management.recordModelProbeFailure(ctx, accountRef, err, credentialSnapshot.UpdatedAt())
		return AccountModelRefreshSnapshot{AccountRef: accountRef}, err
	}
	management.recordModelProbeSuccess(ctx, accountRef, len(discovered), updatedAt, credentialSnapshot.UpdatedAt())
	return AccountModelRefreshSnapshot{AccountRef: accountRef, Models: snapshot}, nil
}

// recordModelProbeSuccess 在目录替换提交后写入成功事实。
//
// 计数取本次发现结果而不是返回的完整关系快照：后者还包含人工 force_enable 的模型，
// 不代表上游目录的真实大小。
func (management *ModelManagement) recordModelProbeSuccess(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	modelCount int,
	updatedAt time.Time,
	credentialUpdatedAt time.Time,
) {
	management.recordModelProbe(ctx, ModelProbeRecord{
		AccountRef:          accountRef,
		AttemptedAt:         updatedAt,
		Succeeded:           true,
		Source:              ModelProbeSourceRemote,
		ModelCount:          modelCount,
		UpdatedAt:           updatedAt,
		CredentialUpdatedAt: credentialUpdatedAt,
	})
}

// recordModelProbeFailure 写入失败事实；取消不是探测结论（关停/换代），直接跳过。
func (management *ModelManagement) recordModelProbeFailure(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	cause error,
	credentialUpdatedAt time.Time,
) {
	if management == nil || management.probes == nil || cause == nil ||
		errors.Is(cause, context.Canceled) {
		return
	}
	attemptedAt, err := normalizeModelTime(management.clock())
	if err != nil {
		return
	}
	management.recordModelProbe(ctx, ModelProbeRecord{
		AccountRef:          accountRef,
		AttemptedAt:         attemptedAt,
		Succeeded:           false,
		Source:              ModelProbeSourceError,
		ErrorCode:           modelProbeErrorCode(cause),
		ErrorMessage:        truncateModelProbeMessage(cause.Error()),
		UpdatedAt:           attemptedAt,
		CredentialUpdatedAt: credentialUpdatedAt,
	})
}

// recordModelProbe 落盘一次探测事实。
//
// 写事实不能反过来改变刷新结论：探测已经成功时，观测写入失败不应让协调器重试并
// 放大上游压力；探测已经失败时，调用方拿到的仍应是原始错误。因此这里显式忽略
// 写入错误。刷新上下文可能已因超时取消（正是要记录的失败），写入必须脱离取消信号。
func (management *ModelManagement) recordModelProbe(
	ctx context.Context,
	record ModelProbeRecord,
) {
	if management == nil || management.probes == nil || ctx == nil {
		return
	}
	_ = management.probes.RecordModelProbe(context.WithoutCancel(ctx), record)
}

// modelProbeErrorCode 把刷新失败归类成稳定的短代码。
//
// 只映射已知哨兵；未知错误统一 refresh_failed，绝不把上游文案写进代码，否则读侧
// 无法稳定分支，也容易把凭据或 URL 带去别的系统。
func modelProbeErrorCode(err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, ErrModelDiscoveryUnsupported):
		return "discovery_unsupported"
	case errors.Is(err, ErrModelAuthenticationRejected):
		return "authentication_rejected"
	case errors.Is(err, ErrModelDiscoveryFailed):
		return "discovery_failed"
	case errors.Is(err, ErrInvalidDiscoveredModels):
		return "invalid_catalog"
	case errors.Is(err, ErrCredentialConflict):
		return "credential_conflict"
	case errors.Is(err, ErrCredentialNotFound):
		return "credential_missing"
	case errors.Is(err, ErrAccountNotFound):
		return "account_not_found"
	default:
		return "refresh_failed"
	}
}

// truncateModelProbeMessage 按字符截断错误消息，避免整段响应正文进入数据库。
func truncateModelProbeMessage(message string) string {
	runes := []rune(message)
	if len(runes) <= MaxModelProbeErrorMessageLength {
		return message
	}
	return string(runes[:MaxModelProbeErrorMessageLength])
}

// SetManualModelPolicy 设置一个真实模型的人工覆盖策略。
func (management *ModelManagement) SetManualModelPolicy(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	modelID string,
	policy ModelManualPolicy,
) ([]AccountModel, error) {
	runtimeModelID, err := runtimecore.NewModelID(modelID)
	if management == nil ||
		!accountRef.IsValid() ||
		err != nil ||
		!policy.IsValid() {
		return nil, ErrInvalidAccountModel
	}
	updatedAt, err := normalizeModelTime(management.clock())
	if err != nil {
		return nil, err
	}
	return management.models.SetManualModelPolicy(
		ctx,
		accountRef,
		runtimeModelID,
		policy,
		updatedAt,
	)
}

// AccountModelSet 是批量读取时单个账号的模型关系。
//
// 放在应用层而不是适配器里：WebUI 的批量读（一次拿全部账号的目录）需要一个与存储
// 实现无关的类型，否则入站适配器要反向依赖 sqlite 适配器。
type AccountModelSet struct {
	AccountRef accountcore.AccountRef
	ProviderID string
	Models     []AccountModel
	// LastAttemptAt 是最近一次模型探测时刻；零值表示这个账号从未探测过。
	LastAttemptAt time.Time
	// LastErrorCode / LastErrorMessage 是最近一次探测的失败事实；成功后清空。
	LastErrorCode    string
	LastErrorMessage string
	// LastSource 是最近一次探测的结果来源（remote / error）；空值表示从未探测。
	LastSource string
	// LastModelCount 是最近一次成功探测得到的模型数量；失败时保留上一次的值，
	// 因为失败不会改变 account_models 里已有的目录快照。
	LastModelCount int
}

// AccountModelCatalog 是一次批量读取的完整结果：账号模型关系 + 目录指纹。
//
// 指纹与 data 在同一次读事务里取得，调用方可以把它当成「这一份 data 的版本号」：
// 相同 generation 表示两次读取之间 account_models / account_model_probes 没有发生
// 可观察的写入，可以跳过重新拉取与重建。
type AccountModelCatalog struct {
	Sets        []AccountModelSet
	Generation  int64
	UpdatedAtMS int64
}

// AccountModelCatalogStamp 是只读目录指纹（不返回账号/模型行）。
//
// 条件刷新只要知道「有没有变」时使用它，避免为了拿 generation 把整份目录
// 序列化到 HTTP 响应里。
type AccountModelCatalogStamp struct {
	Generation  int64
	UpdatedAtMS int64
}
