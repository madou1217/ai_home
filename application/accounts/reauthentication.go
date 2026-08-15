package accounts

import (
	"context"
	"errors"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
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
	// ErrReauthenticationGenerationUnordered 表示 Provider 凭据缺少可比较的代际事实。
	ErrReauthenticationGenerationUnordered = errors.New("账号 OAuth 凭据代际不可比较")
	// ErrInvalidReauthenticatorDependencies 表示重新认证用例缺少 Provider、存储或时钟。
	ErrInvalidReauthenticatorDependencies = errors.New("账号重新认证依赖无效")
)

// Reauthentication 是同一账号 OAuth 凭据和可选公开资料的原子替换命令。
type Reauthentication struct {
	accountRef accountcore.AccountRef
	providerID string
	credential Credential
	profile    ProfileSnapshot
	updatedAt  time.Time
}

// NewReauthentication 校验目标账号、OAuth 结果和可选资料属于同一稳定身份。
func NewReauthentication(
	catalog *providers.Catalog,
	accountRef accountcore.AccountRef,
	credential Credential,
	profile PublicProfile,
	updatedAt time.Time,
) (Reauthentication, error) {
	if catalog == nil ||
		!accountRef.IsValid() ||
		credential == nil {
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
	var profileSnapshot ProfileSnapshot
	if profile != nil {
		profileSnapshot, err = NewProfileSnapshot(catalog, profile, updatedAt)
		if err != nil {
			return Reauthentication{}, ErrInvalidReauthentication
		}
		if profile.ProviderID() != providerID ||
			profileSnapshot.AccountRef() != accountRef {
			return Reauthentication{}, ErrReauthenticationIdentityMismatch
		}
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

// Profile 返回可选的公开资料快照；HasProfile 为 false 时返回零值。
func (reauthentication Reauthentication) Profile() ProfileSnapshot {
	return reauthentication.profile
}

// HasProfile 表示本次重新认证携带经过身份校验的公开资料。
func (reauthentication Reauthentication) HasProfile() bool {
	return reauthentication.profile.Profile() != nil
}

// UpdatedAt 返回本次重新认证的 UTC 毫秒精度时间。
func (reauthentication Reauthentication) UpdatedAt() time.Time {
	return reauthentication.updatedAt
}

// IsValid 重新检查命令在跨层传递后仍满足同身份不变量。
func (reauthentication Reauthentication) IsValid() bool {
	if !reauthentication.accountRef.IsValid() ||
		reauthentication.providerID == "" ||
		reauthentication.credential == nil {
		return false
	}
	credentialRef, credentialErr := accountcore.DeriveAccountRef(
		reauthentication.credential,
	)
	normalizedTime, timeErr := normalizePersistedTime(reauthentication.updatedAt)
	if credentialErr != nil ||
		timeErr != nil ||
		credentialRef != reauthentication.accountRef ||
		reauthentication.credential.ProviderID() != reauthentication.providerID ||
		!normalizedTime.Equal(reauthentication.updatedAt) {
		return false
	}
	if !reauthentication.HasProfile() {
		return true
	}
	profile := reauthentication.profile
	return profile.AccountRef() == reauthentication.accountRef &&
		profile.Profile().ProviderID() == reauthentication.providerID &&
		profile.UpdatedAt().Equal(normalizedTime)
}

// ShouldReplaceCredential 判断导入凭据是否可证明比事务内当前凭据更新。
//
// Codex 只信任凭据自带的最近刷新时间，Claude 只信任 Access Token 绝对
// 过期时间；文档导出时间和请求到达顺序都不是凭据代际事实。
func (reauthentication Reauthentication) ShouldReplaceCredential(
	current Credential,
) (bool, error) {
	if !reauthentication.IsValid() || current == nil {
		return false, ErrInvalidReauthentication
	}
	currentRef, err := accountcore.DeriveAccountRef(current)
	if err != nil ||
		currentRef != reauthentication.AccountRef() ||
		current.ProviderID() != reauthentication.ProviderID() {
		return false, ErrReauthenticationIdentityMismatch
	}
	switch incoming := reauthentication.Credential().(type) {
	case *codex.OAuthAuth:
		stored, valid := current.(*codex.OAuthAuth)
		if !valid || incoming.RefreshedAtMS() <= 0 || stored.RefreshedAtMS() <= 0 {
			return false, ErrReauthenticationGenerationUnordered
		}
		return incoming.RefreshedAtMS() > stored.RefreshedAtMS(), nil
	case *claude.OAuthAuth:
		stored, valid := current.(*claude.OAuthAuth)
		if !valid || incoming.ExpiresAtMS() <= 0 || stored.ExpiresAtMS() <= 0 {
			return false, ErrReauthenticationGenerationUnordered
		}
		return incoming.ExpiresAtMS() > stored.ExpiresAtMS(), nil
	default:
		return false, ErrReauthenticationGenerationUnordered
	}
}

// ReauthenticationStore 原子替换同一账号凭据和可选公开资料。
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
	clock   Clock
}

// NewReauthenticator 使用最小 Provider、存储和时钟依赖创建重新认证用例。
func NewReauthenticator(
	catalog *providers.Catalog,
	store ReauthenticationStore,
	clock Clock,
) (*Reauthenticator, error) {
	if catalog == nil || store == nil || clock == nil {
		return nil, ErrInvalidReauthenticatorDependencies
	}
	return &Reauthenticator{
		catalog: catalog,
		store:   store,
		clock:   clock,
	}, nil
}

// ValidateTarget 在创建 OAuth 私有状态前确认目标账号存在、Provider 一致且可原地认证。
func (reauthenticator *Reauthenticator) ValidateTarget(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	providerID string,
) error {
	_, err := reauthenticator.readTarget(ctx, accountRef, providerID)
	return err
}

// readTarget 统一 OAuth 授权预检和最终写入前的账号版本读取。
func (reauthenticator *Reauthenticator) readTarget(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	providerID string,
) (accountcore.Account, error) {
	if reauthenticator == nil ||
		reauthenticator.catalog == nil ||
		reauthenticator.store == nil ||
		ctx == nil ||
		!accountRef.IsValid() {
		return accountcore.Account{}, ErrInvalidReauthentication
	}
	canonicalProviderID, found := reauthenticator.catalog.CanonicalID(providerID)
	if !found || canonicalProviderID != providerID {
		return accountcore.Account{}, ErrInvalidReauthentication
	}
	account, err := reauthenticator.store.GetReauthenticationTarget(ctx, accountRef)
	if err != nil {
		return accountcore.Account{}, err
	}
	if account.Ref() != accountRef || account.ProviderID() != canonicalProviderID {
		return accountcore.Account{}, ErrReauthenticationIdentityMismatch
	}
	return account, nil
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
	account, err := reauthenticator.readTarget(
		ctx,
		accountRef,
		credential.ProviderID(),
	)
	if err != nil {
		return accountcore.Account{}, err
	}
	updatedAt, err := nextReauthenticationTime(
		reauthenticator.clock(),
		account.UpdatedAt(),
	)
	if err != nil {
		return accountcore.Account{}, err
	}
	reauthentication, err := NewReauthentication(
		reauthenticator.catalog,
		accountRef,
		credential,
		profile,
		updatedAt,
	)
	if err != nil {
		return accountcore.Account{}, err
	}
	return reauthenticator.store.Reauthenticate(ctx, reauthentication)
}

// nextReauthenticationTime 在本地时钟同毫秒或回拨时仍推进聚合 CAS 版本。
func nextReauthenticationTime(
	now time.Time,
	accountUpdatedAt time.Time,
) (time.Time, error) {
	normalizedNow, err := normalizePersistedTime(now)
	if err != nil {
		return time.Time{}, ErrInvalidReauthentication
	}
	if !normalizedNow.After(accountUpdatedAt) {
		normalizedNow = accountUpdatedAt.Add(time.Millisecond)
	}
	if _, err := normalizePersistedTime(normalizedNow); err != nil {
		return time.Time{}, ErrInvalidReauthentication
	}
	return normalizedNow, nil
}

// validateReauthenticationIdentity 在持久化前验证凭据和可选资料的同身份关系。
func validateReauthenticationIdentity(
	catalog *providers.Catalog,
	accountRef accountcore.AccountRef,
	credential Credential,
	profile PublicProfile,
) error {
	if catalog == nil ||
		!accountRef.IsValid() ||
		credential == nil ||
		profile != nil && !profile.IsValid() {
		return ErrInvalidReauthentication
	}
	providerID, found := catalog.CanonicalID(credential.ProviderID())
	if !found || providerID != credential.ProviderID() {
		return ErrInvalidReauthentication
	}
	credentialRef, credentialErr := accountcore.DeriveAccountRef(credential)
	if credentialErr != nil ||
		credentialRef != accountRef {
		return ErrReauthenticationIdentityMismatch
	}
	if profile == nil {
		return nil
	}
	profileRef, profileErr := accountcore.DeriveAccountRef(profile)
	if profileErr != nil ||
		profileRef != accountRef ||
		profile.ProviderID() != providerID {
		return ErrReauthenticationIdentityMismatch
	}
	return nil
}
