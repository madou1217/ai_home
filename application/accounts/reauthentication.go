package accounts

import (
	"context"
	"errors"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

var (
	// ErrInvalidReauthentication 表示重新认证命令缺少必要身份、凭据、资料或时间。
	ErrInvalidReauthentication = errors.New("账号重新认证数据无效")
	// ErrReauthenticationIdentityMismatch 表示新凭据或资料不属于目标账号。
	ErrReauthenticationIdentityMismatch = errors.New("重新认证身份与目标账号不匹配")
	// ErrReauthenticationConflict 表示存在更新版本，当前重新认证结果不能覆盖它。
	ErrReauthenticationConflict = errors.New("账号重新认证冲突")
	// ErrReauthenticationUnsupported 表示目标凭据没有可安全保持的 OAuth 身份。
	ErrReauthenticationUnsupported = errors.New("账号凭据不支持原地重新认证")
	// ErrInvalidReauthenticatorDependencies 表示重新认证用例缺少 Provider、存储或时钟。
	ErrInvalidReauthenticatorDependencies = errors.New("账号重新认证依赖无效")
)

// Reauthentication 是同一账号 OAuth 凭据和公开资料的原子替换命令。
type Reauthentication struct {
	accountRef accountcore.AccountRef
	providerID string
	credential Credential
	profile    ProfileSnapshot
	models     []runtimecore.ModelID
	updatedAt  time.Time
}

// NewReauthentication 校验目标账号、OAuth 结果和公开资料属于同一稳定身份。
func NewReauthentication(
	catalog *providers.Catalog,
	accountRef accountcore.AccountRef,
	credential Credential,
	profile PublicProfile,
	models []runtimecore.ModelID,
	updatedAt time.Time,
) (Reauthentication, error) {
	if catalog == nil ||
		!accountRef.IsValid() ||
		credential == nil ||
		profile == nil ||
		!ValidDiscoveredModelIDs(models) {
		return Reauthentication{}, ErrInvalidReauthentication
	}
	providerID, found := catalog.CanonicalID(credential.ProviderID())
	if !found || providerID != credential.ProviderID() {
		return Reauthentication{}, ErrInvalidReauthentication
	}
	credentialRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil || credentialRef != accountRef {
		return Reauthentication{}, ErrReauthenticationIdentityMismatch
	}
	profileSnapshot, err := NewProfileSnapshot(catalog, profile, updatedAt)
	if err != nil {
		return Reauthentication{}, ErrInvalidReauthentication
	}
	if profile.ProviderID() != providerID ||
		profileSnapshot.AccountRef() != accountRef {
		return Reauthentication{}, ErrReauthenticationIdentityMismatch
	}
	normalizedTime, err := normalizePersistedTime(updatedAt)
	if err != nil {
		return Reauthentication{}, ErrInvalidReauthentication
	}
	return Reauthentication{
		accountRef: accountRef,
		providerID: providerID,
		credential: credential,
		profile:    profileSnapshot,
		models:     append([]runtimecore.ModelID(nil), models...),
		updatedAt:  normalizedTime,
	}, nil
}

// AccountRef 返回必须保持不变的目标账号身份。
func (reauthentication Reauthentication) AccountRef() accountcore.AccountRef {
	return reauthentication.accountRef
}

// ProviderID 返回经过 Catalog 校验的规范 Provider ID。
func (reauthentication Reauthentication) ProviderID() string {
	return reauthentication.providerID
}

// Credential 返回需要替换的同身份 OAuth 凭据。
func (reauthentication Reauthentication) Credential() Credential {
	return reauthentication.credential
}

// Profile 返回需要与凭据一起替换的公开资料快照。
func (reauthentication Reauthentication) Profile() ProfileSnapshot {
	return reauthentication.profile
}

// Models 返回重新认证事务必须同时保存的完整模型发现结果。
func (reauthentication Reauthentication) Models() []runtimecore.ModelID {
	return append([]runtimecore.ModelID(nil), reauthentication.models...)
}

// UpdatedAt 返回本次重新认证的 UTC 毫秒精度时间。
func (reauthentication Reauthentication) UpdatedAt() time.Time {
	return reauthentication.updatedAt
}

// IsValid 重新检查命令在跨层传递后仍满足同身份不变量。
func (reauthentication Reauthentication) IsValid() bool {
	if !reauthentication.accountRef.IsValid() ||
		reauthentication.providerID == "" ||
		reauthentication.credential == nil ||
		reauthentication.profile.Profile() == nil {
		return false
	}
	credentialRef, credentialErr := accountcore.DeriveAccountRef(
		reauthentication.credential,
	)
	normalizedTime, timeErr := normalizePersistedTime(reauthentication.updatedAt)
	profile := reauthentication.profile
	return credentialErr == nil &&
		timeErr == nil &&
		credentialRef == reauthentication.accountRef &&
		reauthentication.credential.ProviderID() == reauthentication.providerID &&
		ValidDiscoveredModelIDs(reauthentication.models) &&
		profile.AccountRef() == reauthentication.accountRef &&
		profile.Profile().ProviderID() == reauthentication.providerID &&
		profile.UpdatedAt().Equal(normalizedTime) &&
		normalizedTime.Equal(reauthentication.updatedAt)
}

// ReauthenticationStore 原子替换同一账号凭据和公开资料。
type ReauthenticationStore interface {
	// GetReauthenticationTarget 返回凭据形态允许原地 OAuth 重新认证的目标账号。
	GetReauthenticationTarget(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountcore.Account, error)
	Reauthenticate(
		ctx context.Context,
		reauthentication Reauthentication,
	) (accountcore.Account, error)
}

// Reauthenticator 创建并执行保持 AccountRef 不变的重新认证命令。
type Reauthenticator struct {
	catalog *providers.Catalog
	store   ReauthenticationStore
	models  *ModelDiscovery
	clock   Clock
}

// NewReauthenticator 使用最小 Provider、存储和时钟依赖创建重新认证用例。
func NewReauthenticator(
	catalog *providers.Catalog,
	store ReauthenticationStore,
	models *ModelDiscovery,
	clock Clock,
) (*Reauthenticator, error) {
	if catalog == nil || store == nil || models == nil || clock == nil {
		return nil, ErrInvalidReauthenticatorDependencies
	}
	return &Reauthenticator{
		catalog: catalog,
		store:   store,
		models:  models,
		clock:   clock,
	}, nil
}

// ValidateTarget 在创建 OAuth 私有状态前确认目标账号存在、Provider 一致且可原地认证。
func (reauthenticator *Reauthenticator) ValidateTarget(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	providerID string,
) error {
	if reauthenticator == nil ||
		reauthenticator.catalog == nil ||
		reauthenticator.store == nil ||
		!accountRef.IsValid() {
		return ErrInvalidReauthentication
	}
	canonicalProviderID, found := reauthenticator.catalog.CanonicalID(providerID)
	if !found || canonicalProviderID != providerID {
		return ErrInvalidReauthentication
	}
	account, err := reauthenticator.store.GetReauthenticationTarget(ctx, accountRef)
	if err != nil {
		return err
	}
	if account.Ref() != accountRef || account.ProviderID() != canonicalProviderID {
		return ErrReauthenticationIdentityMismatch
	}
	return nil
}

// Reauthenticate 原子替换目标账号的同身份 OAuth 凭据和公开资料。
func (reauthenticator *Reauthenticator) Reauthenticate(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	credential Credential,
	profile PublicProfile,
) (accountcore.Account, error) {
	if err := validateReauthenticationIdentity(
		reauthenticator.catalog,
		accountRef,
		credential,
		profile,
	); err != nil {
		return accountcore.Account{}, err
	}
	models, err := reauthenticator.models.DiscoverModels(ctx, credential)
	if err != nil {
		return accountcore.Account{}, err
	}
	reauthentication, err := NewReauthentication(
		reauthenticator.catalog,
		accountRef,
		credential,
		profile,
		models,
		reauthenticator.clock(),
	)
	if err != nil {
		return accountcore.Account{}, err
	}
	return reauthenticator.store.Reauthenticate(ctx, reauthentication)
}

// validateReauthenticationIdentity 在远端目录访问前验证完整同身份关系。
func validateReauthenticationIdentity(
	catalog *providers.Catalog,
	accountRef accountcore.AccountRef,
	credential Credential,
	profile PublicProfile,
) error {
	if catalog == nil ||
		!accountRef.IsValid() ||
		credential == nil ||
		profile == nil ||
		!profile.IsValid() {
		return ErrInvalidReauthentication
	}
	providerID, found := catalog.CanonicalID(credential.ProviderID())
	if !found || providerID != credential.ProviderID() {
		return ErrInvalidReauthentication
	}
	credentialRef, credentialErr := accountcore.DeriveAccountRef(credential)
	profileRef, profileErr := accountcore.DeriveAccountRef(profile)
	if credentialErr != nil ||
		profileErr != nil ||
		credentialRef != accountRef ||
		profileRef != accountRef ||
		profile.ProviderID() != providerID {
		return ErrReauthenticationIdentityMismatch
	}
	return nil
}
