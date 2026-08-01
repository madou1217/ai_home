package accounts

import (
	"context"
	"errors"
	"fmt"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const maxPersistedUnixMillis int64 = 253_402_300_799_999

var (
	// ErrInvalidRegistration 表示账号与凭据不属于同一个稳定业务身份。
	ErrInvalidRegistration = errors.New("账号注册数据无效")
	// ErrInvalidCredentialBinding 表示凭据没有绑定到有效账号或规范 Provider。
	ErrInvalidCredentialBinding = errors.New("账号凭据绑定无效")
	// ErrCredentialNotFound 表示账号没有可用的持久化凭据。
	ErrCredentialNotFound = errors.New("账号凭据不存在")
)

// Credential 是账号应用层允许持久化的最小凭据合同。
//
// Provider 领域认证值负责实现该接口；持久化适配器不能接收任意 map 或未校验 JSON。
type Credential interface {
	accountcore.IdentitySource
	fmt.Stringer
	GoString() string
}

// CredentialBinding 把当前凭据绑定到稳定账号和规范 Provider。
//
// 账号引用不会随静态凭据轮换改变；调用方必须通过该值复核凭据来源，不能再从
// 当前密钥反推账号主键。
type CredentialBinding struct {
	accountRef accountcore.AccountRef
	providerID string
	credential Credential
}

// NewCredentialBinding 创建不暴露凭据内容的账号凭据绑定。
func NewCredentialBinding(
	accountRef accountcore.AccountRef,
	providerID string,
	credential Credential,
) (CredentialBinding, error) {
	if !accountRef.IsValid() ||
		providerID == "" ||
		credential == nil ||
		credential.ProviderID() != providerID {
		return CredentialBinding{}, ErrInvalidCredentialBinding
	}
	return CredentialBinding{
		accountRef: accountRef,
		providerID: providerID,
		credential: credential,
	}, nil
}

// AccountRef 返回凭据所属的稳定账号引用。
func (binding CredentialBinding) AccountRef() accountcore.AccountRef {
	return binding.accountRef
}

// ProviderID 返回凭据所属的规范 Provider。
func (binding CredentialBinding) ProviderID() string {
	return binding.providerID
}

// Credential 返回经过 Provider 领域构造器校验的当前凭据。
func (binding CredentialBinding) Credential() Credential {
	return binding.credential
}

// IsValid 重新检查跨层传递后的账号、Provider 和凭据绑定。
func (binding CredentialBinding) IsValid() bool {
	return binding.accountRef.IsValid() &&
		binding.providerID != "" &&
		binding.credential != nil &&
		binding.credential.ProviderID() == binding.providerID
}

// Registration 是经过校验的账号与凭据原子注册命令。
type Registration struct {
	account             accountcore.Account
	credential          Credential
	credentialUpdatedAt time.Time
}

// NewRegistration 校验账号、凭据身份和更新时间并创建原子注册命令。
func NewRegistration(
	account accountcore.Account,
	credential Credential,
	credentialUpdatedAt time.Time,
) (Registration, error) {
	if !account.IsValid() || credential == nil {
		return Registration{}, ErrInvalidRegistration
	}
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil ||
		accountRef != account.Ref() ||
		credential.ProviderID() != account.ProviderID() {
		return Registration{}, ErrInvalidRegistration
	}
	updatedAt, err := normalizePersistedTime(credentialUpdatedAt)
	if err != nil {
		return Registration{}, ErrInvalidRegistration
	}
	return Registration{
		account:             account,
		credential:          credential,
		credentialUpdatedAt: updatedAt,
	}, nil
}

// Account 返回需要原子创建的基础账号快照。
func (registration Registration) Account() accountcore.Account {
	return registration.account
}

// Credential 返回需要原子保存的 Provider 凭据值。
func (registration Registration) Credential() Credential {
	return registration.credential
}

// CredentialUpdatedAt 返回 UTC 毫秒精度的凭据更新时间。
func (registration Registration) CredentialUpdatedAt() time.Time {
	return registration.credentialUpdatedAt
}

// CredentialStore 是账号凭据原子注册和按需读取所需的持久化端口。
type CredentialStore interface {
	// Register 在同一事务中创建基础账号及其凭据。
	Register(ctx context.Context, registration Registration) error
	// GetCredential 按稳定账号身份读取并重新校验 Provider 凭据。
	GetCredential(ctx context.Context, accountRef accountcore.AccountRef) (Credential, error)
}

// normalizePersistedTime 将应用边界时间规范化为 UTC Unix 毫秒。
func normalizePersistedTime(value time.Time) (time.Time, error) {
	if value.IsZero() {
		return time.Time{}, ErrInvalidRegistration
	}
	unixMillis := value.UnixMilli()
	if unixMillis < 0 || unixMillis > maxPersistedUnixMillis {
		return time.Time{}, ErrInvalidRegistration
	}
	return time.UnixMilli(unixMillis).UTC(), nil
}
