package accounts

import (
	"context"
	"errors"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var (
	// ErrInvalidCredentialSnapshot 表示凭据、账号身份或持久化版本不一致。
	ErrInvalidCredentialSnapshot = errors.New("账号凭据快照无效")
	// ErrInvalidCredentialReplacement 表示替换凭据改变身份或没有推进版本。
	ErrInvalidCredentialReplacement = errors.New("账号凭据替换无效")
	// ErrCredentialConflict 表示凭据已经被其他更新者替换。
	ErrCredentialConflict = errors.New("账号凭据版本冲突")
)

// CredentialSnapshot 是带持久化版本的已校验凭据快照。
type CredentialSnapshot struct {
	binding   CredentialBinding
	updatedAt time.Time
}

// NewCredentialSnapshot 校验凭据身份和毫秒精度版本后创建快照。
func NewCredentialSnapshot(
	accountRef accountcore.AccountRef,
	providerID string,
	credential Credential,
	updatedAt time.Time,
) (CredentialSnapshot, error) {
	normalizedTime, err := normalizePersistedTime(updatedAt)
	binding, bindingErr := NewCredentialBinding(
		accountRef,
		providerID,
		credential,
	)
	if err != nil || bindingErr != nil {
		return CredentialSnapshot{}, ErrInvalidCredentialSnapshot
	}
	return CredentialSnapshot{
		binding:   binding,
		updatedAt: normalizedTime,
	}, nil
}

// AccountRef 返回快照绑定的稳定账号身份。
func (snapshot CredentialSnapshot) AccountRef() accountcore.AccountRef {
	return snapshot.binding.AccountRef()
}

// ProviderID 返回快照绑定的规范 Provider。
func (snapshot CredentialSnapshot) ProviderID() string {
	return snapshot.binding.ProviderID()
}

// Credential 返回经过 Provider 领域构造器校验的凭据。
func (snapshot CredentialSnapshot) Credential() Credential {
	return snapshot.binding.Credential()

}

// Binding 返回不依赖当前密钥派生账号主键的绑定值。
func (snapshot CredentialSnapshot) Binding() CredentialBinding {
	return snapshot.binding
}

// UpdatedAt 返回凭据当前的 UTC 毫秒精度版本。
func (snapshot CredentialSnapshot) UpdatedAt() time.Time {
	return snapshot.updatedAt
}

// IsValid 重新检查跨层传递后的凭据快照不变量。
func (snapshot CredentialSnapshot) IsValid() bool {
	normalizedTime, err := normalizePersistedTime(snapshot.updatedAt)
	return err == nil &&
		normalizedTime.Equal(snapshot.updatedAt) &&
		snapshot.binding.IsValid()
}

// CredentialReplacement 是一次保持账号身份不变的 CAS 凭据替换命令。
type CredentialReplacement struct {
	accountRef        accountcore.AccountRef
	expectedUpdatedAt time.Time
	credential        Credential
	updatedAt         time.Time
}

// NewCredentialReplacement 从当前快照创建版本严格递增的凭据替换命令。
func NewCredentialReplacement(
	current CredentialSnapshot,
	credential Credential,
	updatedAt time.Time,
) (CredentialReplacement, error) {
	normalizedTime, err := normalizePersistedTime(updatedAt)
	if err != nil ||
		!current.IsValid() ||
		!credentialMatchesAccount(current.AccountRef(), current.Credential()) ||
		!credentialMatchesAccount(current.AccountRef(), credential) ||
		credential.ProviderID() != current.ProviderID() ||
		!normalizedTime.After(current.UpdatedAt()) {
		return CredentialReplacement{}, ErrInvalidCredentialReplacement
	}
	return CredentialReplacement{
		accountRef:        current.AccountRef(),
		expectedUpdatedAt: current.UpdatedAt(),
		credential:        credential,
		updatedAt:         normalizedTime,
	}, nil
}

// AccountRef 返回禁止变化的目标账号身份。
func (replacement CredentialReplacement) AccountRef() accountcore.AccountRef {
	return replacement.accountRef
}

// ExpectedUpdatedAt 返回 compare-and-swap 期望的旧版本。
func (replacement CredentialReplacement) ExpectedUpdatedAt() time.Time {
	return replacement.expectedUpdatedAt
}

// Credential 返回已经确认身份不变的新凭据。
func (replacement CredentialReplacement) Credential() Credential {
	return replacement.credential
}

// UpdatedAt 返回替换成功后写入的新版本。
func (replacement CredentialReplacement) UpdatedAt() time.Time {
	return replacement.updatedAt
}

// IsValid 重新检查凭据替换命令的身份和版本不变量。
func (replacement CredentialReplacement) IsValid() bool {
	current, err := NewCredentialSnapshot(
		replacement.accountRef,
		replacement.credential.ProviderID(),
		replacement.credential,
		replacement.expectedUpdatedAt,
	)
	if err != nil {
		return false
	}
	_, err = NewCredentialReplacement(
		current,
		replacement.credential,
		replacement.updatedAt,
	)
	return err == nil
}

// CredentialVersionStore 提供凭据可用化所需的版本化读取和 CAS 写入。
type CredentialVersionStore interface {
	// GetCredentialSnapshot 返回目标账号的当前凭据和版本。
	GetCredentialSnapshot(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (CredentialSnapshot, error)
	// ReplaceCredential 只在旧版本匹配时原子替换凭据。
	ReplaceCredential(
		ctx context.Context,
		replacement CredentialReplacement,
	) error
}

// credentialMatchesAccount 确保凭据 Provider 身份仍然派生到目标账号。
func credentialMatchesAccount(
	accountRef accountcore.AccountRef,
	credential Credential,
) bool {
	if credential == nil {
		return false
	}
	derivedRef, err := accountcore.DeriveAccountRef(credential)
	return err == nil && derivedRef == accountRef
}
