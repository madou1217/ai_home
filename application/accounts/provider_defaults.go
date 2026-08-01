package accounts

import (
	"context"
	"errors"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
)

var (
	// ErrInvalidProviderDefaultDependencies 表示默认账号用例缺少 Provider、存储或时钟。
	ErrInvalidProviderDefaultDependencies = errors.New("Provider 默认账号依赖无效")
	// ErrInvalidProviderDefault 表示 Provider、账号身份或时间不满足默认关系合同。
	ErrInvalidProviderDefault = errors.New("Provider 默认账号数据无效")
	// ErrProviderDefaultNotFound 表示指定 Provider 当前没有默认账号。
	ErrProviderDefaultNotFound = errors.New("Provider 默认账号不存在")
	// ErrProviderDefaultMismatch 表示目标账号不属于请求中的 Provider。
	ErrProviderDefaultMismatch = errors.New("Provider 默认账号归属不匹配")
	// ErrProviderDefaultDisabled 表示已停用账号不能成为默认启动账号。
	ErrProviderDefaultDisabled = errors.New("已停用账号不能设为 Provider 默认账号")
	// ErrProviderDefaultUnconfigured 表示没有完整凭据的账号不能成为默认启动账号。
	ErrProviderDefaultUnconfigured = errors.New("未配置账号不能设为 Provider 默认账号")
	// ErrProviderDefaultConflict 表示并发写入导致默认关系未能安全提交。
	ErrProviderDefaultConflict = errors.New("Provider 默认账号写入冲突")
)

// ProviderDefaultStore 是默认账号用例依赖的最小持久化端口。
type ProviderDefaultStore interface {
	GetProviderDefault(
		ctx context.Context,
		providerID string,
	) (accountcore.ProviderDefault, error)
	SetProviderDefault(
		ctx context.Context,
		providerDefault accountcore.ProviderDefault,
	) (accountcore.ProviderDefault, error)
	ClearProviderDefault(ctx context.Context, providerID string) error
}

// ProviderDefaults 编排 Provider 默认启动账号的读取、替换和清除。
type ProviderDefaults struct {
	catalog *providers.Catalog
	store   ProviderDefaultStore
	clock   Clock
}

// NewProviderDefaults 使用细粒度端口创建默认账号用例。
func NewProviderDefaults(
	catalog *providers.Catalog,
	store ProviderDefaultStore,
	clock Clock,
) (*ProviderDefaults, error) {
	if catalog == nil || store == nil || clock == nil {
		return nil, ErrInvalidProviderDefaultDependencies
	}
	return &ProviderDefaults{catalog: catalog, store: store, clock: clock}, nil
}

// Get 返回指定 Provider 当前默认启动账号。
func (defaults *ProviderDefaults) Get(
	ctx context.Context,
	providerID string,
) (accountcore.ProviderDefault, error) {
	canonicalProviderID, err := defaults.canonicalProviderID(providerID)
	if err != nil {
		return accountcore.ProviderDefault{}, err
	}
	return defaults.store.GetProviderDefault(ctx, canonicalProviderID)
}

// Set 原子替换指定 Provider 的默认启动账号。
func (defaults *ProviderDefaults) Set(
	ctx context.Context,
	providerID string,
	accountRef accountcore.AccountRef,
) (accountcore.ProviderDefault, error) {
	canonicalProviderID, err := defaults.canonicalProviderID(providerID)
	if err != nil || !accountRef.IsValid() {
		return accountcore.ProviderDefault{}, ErrInvalidProviderDefault
	}
	providerDefault, err := accountcore.NewProviderDefault(
		canonicalProviderID,
		accountRef,
		defaults.clock(),
	)
	if err != nil {
		return accountcore.ProviderDefault{}, ErrInvalidProviderDefault
	}
	return defaults.store.SetProviderDefault(ctx, providerDefault)
}

// Clear 幂等清除指定 Provider 的默认启动账号。
func (defaults *ProviderDefaults) Clear(
	ctx context.Context,
	providerID string,
) error {
	canonicalProviderID, err := defaults.canonicalProviderID(providerID)
	if err != nil {
		return err
	}
	return defaults.store.ClearProviderDefault(ctx, canonicalProviderID)
}

// canonicalProviderID 只接受 Catalog 中已经规范化的 Provider ID。
func (defaults *ProviderDefaults) canonicalProviderID(
	providerID string,
) (string, error) {
	if defaults == nil || defaults.catalog == nil || defaults.store == nil {
		return "", ErrInvalidProviderDefaultDependencies
	}
	canonicalProviderID, found := defaults.catalog.CanonicalID(providerID)
	if !found ||
		canonicalProviderID != providerID ||
		!supportsProviderDefault(canonicalProviderID) {
		return "", ErrInvalidProviderDefault
	}
	return canonicalProviderID, nil
}

// supportsProviderDefault 限定本阶段只交付已经重构完成的 Codex 和 Claude 账号。
func supportsProviderDefault(providerID string) bool {
	return providerID == codex.ProviderID || providerID == claude.ProviderID
}
