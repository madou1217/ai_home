package accounts

import (
	"errors"
	"time"

	"github.com/madou1217/ai_home/core/providers"
)

const maxAccountUnixMillis int64 = 253_402_300_799_999

var (
	// ErrInvalidAccount 表示账号快照自身不满足基础聚合不变量。
	ErrInvalidAccount = errors.New("账号快照无效")
	// ErrUnknownProvider 表示身份来源没有对应的 Provider 合同。
	ErrUnknownProvider = errors.New("账号 Provider 未注册")
	// ErrInvalidAccountTime 表示账号业务时间不在可持久化范围内。
	ErrInvalidAccountTime = errors.New("账号时间无效")
	// ErrAccountTimeRegression 表示生命周期变更时间早于当前账号版本。
	ErrAccountTimeRegression = errors.New("账号时间发生倒退")
)

// NewAccountInput 是创建账号基础实体所需的最小输入。
type NewAccountInput struct {
	// Identity 是已经由 Provider 领域校验的认证身份来源。
	Identity IdentitySource
	// CLIAccountID 是本机分配的用户可见数字别名。
	CLIAccountID CLIAccountID
	// CreatedAt 是账号首次注册的业务时间。
	CreatedAt time.Time
}

// Account 是账号基础聚合的不可变快照。
//
// 凭据、公开资料、套餐、额度、模型和运行态属于独立边界，不能放入该实体。
type Account struct {
	ref          AccountRef
	providerID   string
	cliAccountID CLIAccountID
	enabled      bool
	createdAt    time.Time
	updatedAt    time.Time
}

// NewAccount 根据 Provider 合同和认证身份创建默认启用的账号。
func NewAccount(catalog *providers.Catalog, input NewAccountInput) (Account, error) {
	providerID, identitySeed, err := readIdentitySource(input.Identity)
	if err != nil {
		return Account{}, err
	}
	if catalog == nil {
		return Account{}, ErrUnknownProvider
	}
	if !catalog.Contains(providerID) {
		return Account{}, ErrUnknownProvider
	}
	if !input.CLIAccountID.IsValid() {
		return Account{}, ErrInvalidCLIAccountID
	}
	createdAt, err := normalizeAccountTime(input.CreatedAt)
	if err != nil {
		return Account{}, err
	}
	accountRef := deriveAccountRefFromSeed(identitySeed)
	return Account{
		ref:          accountRef,
		providerID:   providerID,
		cliAccountID: input.CLIAccountID,
		enabled:      true,
		createdAt:    createdAt,
		updatedAt:    createdAt,
	}, nil
}

// Ref 返回不可变的公开账号业务身份。
func (account Account) Ref() AccountRef {
	return account.ref
}

// ProviderID 返回账号所属的规范 Provider ID。
func (account Account) ProviderID() string {
	return account.providerID
}

// CLIAccountID 返回本机用户可见数字别名。
func (account Account) CLIAccountID() CLIAccountID {
	return account.cliAccountID
}

// Enabled 返回用户是否允许该账号参与后续业务。
//
// 该值不表达凭据健康、额度、模型 cooldown 或 Server 可调度性。
func (account Account) Enabled() bool {
	return account.enabled
}

// CreatedAt 返回毫秒精度的 UTC 创建时间。
func (account Account) CreatedAt() time.Time {
	return account.createdAt
}

// UpdatedAt 返回毫秒精度的 UTC 最后业务修改时间。
func (account Account) UpdatedAt() time.Time {
	return account.updatedAt
}

// IsValid 判断账号快照是否满足身份、别名和时间不变量。
func (account Account) IsValid() bool {
	return account.ref.IsValid() &&
		isCanonicalProviderID(account.providerID) &&
		account.cliAccountID.IsValid() &&
		isCanonicalAccountTime(account.createdAt) &&
		isCanonicalAccountTime(account.updatedAt) &&
		!account.updatedAt.Before(account.createdAt)
}

// WithEnabled 返回启停状态更新后的独立账号快照。
//
// 重复设置相同状态是幂等操作，不更新 UpdatedAt。
func (account Account) WithEnabled(enabled bool, changedAt time.Time) (Account, error) {
	if !account.IsValid() {
		return Account{}, ErrInvalidAccount
	}
	if account.enabled == enabled {
		return account, nil
	}
	normalizedTime, err := normalizeAccountTime(changedAt)
	if err != nil {
		return Account{}, err
	}
	if normalizedTime.Before(account.updatedAt) {
		return Account{}, ErrAccountTimeRegression
	}
	account.enabled = enabled
	account.updatedAt = normalizedTime
	return account, nil
}

// isCanonicalAccountTime 判断领域时间是否已经规范化为 UTC 毫秒。
func isCanonicalAccountTime(value time.Time) bool {
	if value.IsZero() || value.Location() != time.UTC || value.Nanosecond()%int(time.Millisecond) != 0 {
		return false
	}
	unixMillis := value.UnixMilli()
	return unixMillis >= 0 && unixMillis <= maxAccountUnixMillis
}

// normalizeAccountTime 统一领域时间为 SQLite 和跨语言合同使用的 UTC 毫秒精度。
func normalizeAccountTime(value time.Time) (time.Time, error) {
	if value.IsZero() {
		return time.Time{}, ErrInvalidAccountTime
	}
	unixMillis := value.UnixMilli()
	if unixMillis < 0 || unixMillis > maxAccountUnixMillis {
		return time.Time{}, ErrInvalidAccountTime
	}
	return time.UnixMilli(unixMillis).UTC(), nil
}
