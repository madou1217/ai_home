package accounts

import (
	"context"
	"errors"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

var (
	// ErrInvalidRegistrarDependencies 表示注册用例缺少 Provider、持久化或时钟依赖。
	ErrInvalidRegistrarDependencies = errors.New("账号注册依赖无效")
	// ErrCLIAccountIDExhausted 表示 Provider 已经没有可分配的 SQLite 正整数别名。
	ErrCLIAccountIDExhausted = errors.New("CLI 账号别名已耗尽")
)

// RegistrationRequest 是等待持久化层原子分配 CLI 别名的账号注册命令。
type RegistrationRequest struct {
	accountRef      accountcore.AccountRef
	providerID      string
	credential      Credential
	profileSnapshot ProfileSnapshot
	hasProfile      bool
	registeredAt    time.Time
}

// NewRegistrationRequest 绑定凭据、可选公开资料、稳定身份和注册时间。
func NewRegistrationRequest(
	catalog *providers.Catalog,
	credential Credential,
	profile PublicProfile,
	registeredAt time.Time,
) (RegistrationRequest, error) {
	if catalog == nil || credential == nil {
		return RegistrationRequest{}, ErrInvalidRegistration
	}
	providerID, found := catalog.CanonicalID(credential.ProviderID())
	if !found || providerID != credential.ProviderID() {
		return RegistrationRequest{}, ErrInvalidRegistration
	}
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		return RegistrationRequest{}, ErrInvalidRegistration
	}
	normalizedTime, err := normalizePersistedTime(registeredAt)
	if err != nil {
		return RegistrationRequest{}, ErrInvalidRegistration
	}
	request := RegistrationRequest{
		accountRef:   accountRef,
		providerID:   providerID,
		credential:   credential,
		registeredAt: normalizedTime,
	}
	if profile == nil {
		return request, nil
	}
	snapshot, err := NewProfileSnapshot(catalog, profile, normalizedTime)
	if err != nil ||
		snapshot.AccountRef() != accountRef ||
		profile.ProviderID() != providerID {
		return RegistrationRequest{}, ErrInvalidRegistration
	}
	request.profileSnapshot = snapshot
	request.hasProfile = true
	return request, nil
}

// AccountRef 返回从凭据派生的稳定账号身份。
func (request RegistrationRequest) AccountRef() accountcore.AccountRef {
	return request.accountRef
}

// ProviderID 返回经过 Catalog 校验的规范 Provider ID。
func (request RegistrationRequest) ProviderID() string {
	return request.providerID
}

// Credential 返回需要原子保存的 Provider 凭据。
func (request RegistrationRequest) Credential() Credential {
	return request.credential
}

// HasProfile 返回注册命令是否携带同身份公开资料。
func (request RegistrationRequest) HasProfile() bool {
	return request.hasProfile
}

// ProfileSnapshot 返回需要与账号、凭据一起写入的公开资料快照。
func (request RegistrationRequest) ProfileSnapshot() ProfileSnapshot {
	return request.profileSnapshot
}

// RegisteredAt 返回 UTC 毫秒精度的账号注册时间。
func (request RegistrationRequest) RegisteredAt() time.Time {
	return request.registeredAt
}

// IsValid 判断注册命令的凭据、资料、身份和时间是否仍然一致。
func (request RegistrationRequest) IsValid() bool {
	if request.credential == nil ||
		!request.accountRef.IsValid() ||
		request.providerID == "" {
		return false
	}
	accountRef, err := accountcore.DeriveAccountRef(request.credential)
	normalizedTime, timeErr := normalizePersistedTime(request.registeredAt)
	if err != nil ||
		timeErr != nil ||
		accountRef != request.accountRef ||
		request.credential.ProviderID() != request.providerID ||
		!normalizedTime.Equal(request.registeredAt) {
		return false
	}
	if !request.hasProfile {
		return request.profileSnapshot.Profile() == nil
	}
	profile := request.profileSnapshot.Profile()
	return profile != nil &&
		profile.IsValid() &&
		profile.ProviderID() == request.providerID &&
		request.profileSnapshot.AccountRef() == request.accountRef &&
		request.profileSnapshot.UpdatedAt().Equal(request.registeredAt)
}

// RegistrationStore 是新账号原子分配别名并持久化当前快照的端口。
type RegistrationStore interface {
	RegisterNew(
		ctx context.Context,
		request RegistrationRequest,
	) (accountcore.Account, error)
}

// Registrar 创建并执行不允许调用方指定 CLI 别名的账号注册命令。
type Registrar struct {
	catalog *providers.Catalog
	store   RegistrationStore
	clock   Clock
}

// NewRegistrar 创建依赖完整的账号注册用例。
func NewRegistrar(
	catalog *providers.Catalog,
	store RegistrationStore,
	clock Clock,
) (*Registrar, error) {
	if catalog == nil || store == nil || clock == nil {
		return nil, ErrInvalidRegistrarDependencies
	}
	return &Registrar{catalog: catalog, store: store, clock: clock}, nil
}

// Register 原子创建基础账号、凭据和可选公开资料。
func (registrar *Registrar) Register(
	ctx context.Context,
	credential Credential,
	profile PublicProfile,
) (accountcore.Account, error) {
	request, err := NewRegistrationRequest(
		registrar.catalog,
		credential,
		profile,
		registrar.clock(),
	)
	if err != nil {
		return accountcore.Account{}, err
	}
	return registrar.store.RegisterNew(ctx, request)
}
