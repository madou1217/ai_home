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
	// ErrInvalidStaticCredentialRotation 表示轮换命令没有保持账号和 Provider 边界。
	ErrInvalidStaticCredentialRotation = errors.New("静态账号凭据轮换无效")
	// ErrStaticCredentialRotationUnsupported 表示目标账号不是可原地轮换的静态凭据。
	ErrStaticCredentialRotationUnsupported = errors.New("账号凭据不支持静态轮换")
	// ErrStaticCredentialRotationConflict 表示账号或凭据已被并发修改，或者新凭据已被占用。
	ErrStaticCredentialRotationConflict = errors.New("静态账号凭据轮换冲突")
	// ErrInvalidStaticCredentialRotatorDependencies 表示用例缺少目录、存储、清理或时钟依赖。
	ErrInvalidStaticCredentialRotatorDependencies = errors.New("静态账号凭据轮换依赖无效")
)

// StaticCredentialRotation 是保持 AccountRef 不变的完整静态凭据轮换命令。
type StaticCredentialRotation struct {
	account     accountcore.Account
	current     CredentialSnapshot
	replacement Credential
	updatedAt   time.Time
}

// NewStaticCredentialRotation 创建可由持久化层执行 CAS 的轮换命令。
func NewStaticCredentialRotation(
	account accountcore.Account,
	current CredentialSnapshot,
	replacement Credential,
	updatedAt time.Time,
) (StaticCredentialRotation, error) {
	normalizedTime, err := normalizePersistedTime(updatedAt)
	if err != nil ||
		!validStaticCredentialRotation(
			account,
			current,
			replacement,
			normalizedTime,
		) {
		return StaticCredentialRotation{}, ErrInvalidStaticCredentialRotation
	}
	return StaticCredentialRotation{
		account:     account,
		current:     current,
		replacement: replacement,
		updatedAt:   normalizedTime,
	}, nil
}

// AccountRef 返回轮换前后都必须保持不变的稳定账号引用。
func (rotation StaticCredentialRotation) AccountRef() accountcore.AccountRef {
	return rotation.account.Ref()
}

// ProviderID 返回目标账号的规范 Provider。
func (rotation StaticCredentialRotation) ProviderID() string {
	return rotation.account.ProviderID()
}

// ExpectedAccountUpdatedAt 返回基础账号的 CAS 旧值。
func (rotation StaticCredentialRotation) ExpectedAccountUpdatedAt() time.Time {
	return rotation.account.UpdatedAt()
}

// ExpectedCredentialUpdatedAt 返回当前凭据的 CAS 旧值。
func (rotation StaticCredentialRotation) ExpectedCredentialUpdatedAt() time.Time {
	return rotation.current.UpdatedAt()
}

// CurrentCredential 返回轮换前的静态凭据，仅用于持久化层复核类型和查重引用。
func (rotation StaticCredentialRotation) CurrentCredential() Credential {
	return rotation.current.Credential()
}

// Replacement 返回经过 Provider 领域构造器校验的新静态凭据。
func (rotation StaticCredentialRotation) Replacement() Credential {
	return rotation.replacement
}

// UpdatedAt 返回账号、凭据和模型共同推进到的业务时间。
func (rotation StaticCredentialRotation) UpdatedAt() time.Time {
	return rotation.updatedAt
}

// IsValid 重新检查跨层传递后的完整轮换不变量。
func (rotation StaticCredentialRotation) IsValid() bool {
	return validStaticCredentialRotation(
		rotation.account,
		rotation.current,
		rotation.replacement,
		rotation.updatedAt,
	)
}

// validStaticCredentialRotation 集中维护账号、Provider、类型、模型和时间约束。
func validStaticCredentialRotation(
	account accountcore.Account,
	current CredentialSnapshot,
	replacement Credential,
	updatedAt time.Time,
) bool {
	normalizedTime, timeErr := normalizePersistedTime(updatedAt)
	return timeErr == nil &&
		normalizedTime.Equal(updatedAt) &&
		account.IsValid() &&
		current.IsValid() &&
		current.AccountRef() == account.Ref() &&
		current.ProviderID() == account.ProviderID() &&
		isRotatableStaticCredential(current.Credential()) &&
		isRotatableStaticCredential(replacement) &&
		replacement.ProviderID() == account.ProviderID() &&
		updatedAt.After(account.UpdatedAt()) &&
		updatedAt.After(current.UpdatedAt())
}

// isRotatableStaticCredential 只允许当前已研究的 Codex/Claude 静态凭据形态。
func isRotatableStaticCredential(credential Credential) bool {
	switch credential.(type) {
	case *codex.APIKeyAuth, *claude.APIKeyAuth, *claude.AuthTokenAuth:
		return true
	default:
		return false
	}
}

// StaticCredentialRotationStore 提供轮换所需的最小账号、凭据和原子写入端口。
type StaticCredentialRotationStore interface {
	GetByRef(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountcore.Account, error)
	GetCredentialSnapshot(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (CredentialSnapshot, error)
	RotateStaticCredential(
		ctx context.Context,
		rotation StaticCredentialRotation,
	) (accountcore.Account, error)
}

// StaticCredentialRotator 编排校验、模型发现、原子写入和提交后运行态清理。
type StaticCredentialRotator struct {
	catalog  *providers.Catalog
	store    StaticCredentialRotationStore
	cleanups []DeletionCleanup
	clock    Clock
}

// NewStaticCredentialRotator 创建依赖完整的静态凭据轮换用例。
func NewStaticCredentialRotator(
	catalog *providers.Catalog,
	store StaticCredentialRotationStore,
	clock Clock,
	cleanups ...DeletionCleanup,
) (*StaticCredentialRotator, error) {
	if catalog == nil || store == nil || clock == nil || len(cleanups) == 0 {
		return nil, ErrInvalidStaticCredentialRotatorDependencies
	}
	for _, cleanup := range cleanups {
		if cleanup == nil {
			return nil, ErrInvalidStaticCredentialRotatorDependencies
		}
	}
	return &StaticCredentialRotator{
		catalog:  catalog,
		store:    store,
		cleanups: append([]DeletionCleanup(nil), cleanups...),
		clock:    clock,
	}, nil
}

// Rotate 在同一个 AccountRef 下轮换静态凭据并重建自动发现模型。
func (rotator *StaticCredentialRotator) Rotate(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	replacement Credential,
) (accountcore.Account, error) {
	if rotator == nil ||
		rotator.catalog == nil ||
		rotator.store == nil ||
		len(rotator.cleanups) == 0 ||
		ctx == nil ||
		!accountRef.IsValid() ||
		replacement == nil {
		return accountcore.Account{}, ErrInvalidStaticCredentialRotation
	}
	if err := ctx.Err(); err != nil {
		return accountcore.Account{}, err
	}
	account, current, err := rotator.readTarget(ctx, accountRef)
	if err != nil {
		return accountcore.Account{}, err
	}
	if !isRotatableStaticCredential(current.Credential()) ||
		!isRotatableStaticCredential(replacement) {
		return accountcore.Account{}, ErrStaticCredentialRotationUnsupported
	}
	if replacement.ProviderID() != account.ProviderID() {
		return accountcore.Account{}, ErrInvalidStaticCredentialRotation
	}
	updatedAt, err := nextStaticCredentialRotationTime(
		rotator.clock(),
		account.UpdatedAt(),
		current.UpdatedAt(),
	)
	if err != nil {
		return accountcore.Account{}, err
	}
	rotation, err := NewStaticCredentialRotation(
		account,
		current,
		replacement,
		updatedAt,
	)
	if err != nil {
		return accountcore.Account{}, err
	}
	updated, err := rotator.store.RotateStaticCredential(ctx, rotation)
	if err != nil {
		return accountcore.Account{}, err
	}
	for _, cleanup := range rotator.cleanups {
		cleanup.ForgetAccount(accountRef)
	}
	return updated, nil
}

// readTarget 按固定顺序读取基础账号和当前凭据绑定。
func (rotator *StaticCredentialRotator) readTarget(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (accountcore.Account, CredentialSnapshot, error) {
	account, err := rotator.store.GetByRef(ctx, accountRef)
	if err != nil {
		return accountcore.Account{}, CredentialSnapshot{}, err
	}
	current, err := rotator.store.GetCredentialSnapshot(ctx, accountRef)
	if err != nil {
		return accountcore.Account{}, CredentialSnapshot{}, err
	}
	providerID, found := rotator.catalog.CanonicalID(account.ProviderID())
	if !found ||
		providerID != account.ProviderID() ||
		!current.IsValid() ||
		current.AccountRef() != account.Ref() ||
		current.ProviderID() != providerID {
		return accountcore.Account{}, CredentialSnapshot{}, ErrInvalidStaticCredentialRotation
	}
	return account, current, nil
}

// nextStaticCredentialRotationTime 生成晚于账号和凭据版本的毫秒时间。
func nextStaticCredentialRotationTime(
	now time.Time,
	accountUpdatedAt time.Time,
	credentialUpdatedAt time.Time,
) (time.Time, error) {
	normalizedNow, err := normalizePersistedTime(now)
	if err != nil {
		return time.Time{}, ErrInvalidStaticCredentialRotation
	}
	latest := accountUpdatedAt
	if credentialUpdatedAt.After(latest) {
		latest = credentialUpdatedAt
	}
	if !normalizedNow.After(latest) {
		normalizedNow = latest.Add(time.Millisecond)
	}
	if _, err := normalizePersistedTime(normalizedNow); err != nil {
		return time.Time{}, ErrInvalidStaticCredentialRotation
	}
	return normalizedNow, nil
}
