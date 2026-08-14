package accounts

import (
	"context"
	"errors"
	"fmt"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
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
	clock       Clock
}

// NewModelManagement 创建只用于账号管理写路径的模型用例。
func NewModelManagement(
	credentials AccountCredentialSnapshotReader,
	models AccountModelStore,
	discovery *ModelDiscovery,
	clock Clock,
) (*ModelManagement, error) {
	if credentials == nil || models == nil || discovery == nil || clock == nil {
		return nil, ErrInvalidModelManagementDependencies
	}
	return &ModelManagement{
		credentials: credentials,
		models:      models,
		discovery:   discovery,
		clock:       clock,
	}, nil
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

// RefreshAccountModels 读取当前凭据并全量刷新上游发现部分。
func (management *ModelManagement) RefreshAccountModels(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) ([]AccountModel, error) {
	if management == nil || !accountRef.IsValid() {
		return nil, ErrInvalidAccountModel
	}
	credentialSnapshot, err := management.credentials.GetCredentialSnapshot(
		ctx,
		accountRef,
	)
	if err != nil {
		return nil, err
	}
	if !credentialSnapshot.IsValid() ||
		credentialSnapshot.AccountRef() != accountRef {
		return nil, ErrInvalidAccountModel
	}
	models, err := management.discovery.DiscoverModels(
		ctx,
		credentialSnapshot.Credential(),
	)
	if err != nil {
		return nil, err
	}
	updatedAt, err := normalizeModelTime(management.clock())
	if err != nil {
		return nil, err
	}
	return management.models.ReplaceDiscoveredModelsIfCredentialVersion(
		ctx,
		accountRef,
		models,
		credentialSnapshot.UpdatedAt(),
		updatedAt,
	)
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
