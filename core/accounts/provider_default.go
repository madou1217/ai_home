package accounts

import (
	"errors"
	"time"
)

// ErrInvalidProviderDefault 表示默认关系的 Provider、账号身份或持久化时间无效。
var ErrInvalidProviderDefault = errors.New("Provider 默认账号关系无效")

// ProviderDefault 是一个 Provider 当前默认启动账号的不可变值对象。
//
// 默认关系只表达用户启动偏好，不表达账号运行健康、额度、模型 cooldown 或网关调度资格。
type ProviderDefault struct {
	providerID string
	accountRef AccountRef
	updatedAt  time.Time
}

// NewProviderDefault 创建使用规范 Provider、稳定账号身份和毫秒时间的默认关系。
func NewProviderDefault(
	providerID string,
	accountRef AccountRef,
	updatedAt time.Time,
) (ProviderDefault, error) {
	if !isCanonicalProviderID(providerID) || !accountRef.IsValid() {
		return ProviderDefault{}, ErrInvalidProviderDefault
	}
	normalizedTime, err := normalizeAccountTime(updatedAt)
	if err != nil {
		return ProviderDefault{}, err
	}
	return ProviderDefault{
		providerID: providerID,
		accountRef: accountRef,
		updatedAt:  normalizedTime,
	}, nil
}

// RestoreProviderDefault 从可信持久化字段恢复默认关系，拒绝非规范时间。
func RestoreProviderDefault(
	providerID string,
	accountRef AccountRef,
	updatedAt time.Time,
) (ProviderDefault, error) {
	if !isCanonicalProviderID(providerID) ||
		!accountRef.IsValid() ||
		!isCanonicalAccountTime(updatedAt) {
		return ProviderDefault{}, ErrInvalidProviderDefault
	}
	return ProviderDefault{
		providerID: providerID,
		accountRef: accountRef,
		updatedAt:  updatedAt,
	}, nil
}

// ProviderID 返回默认关系所属的规范 Provider ID。
func (providerDefault ProviderDefault) ProviderID() string {
	return providerDefault.providerID
}

// AccountRef 返回当前默认启动账号的稳定身份。
func (providerDefault ProviderDefault) AccountRef() AccountRef {
	return providerDefault.accountRef
}

// UpdatedAt 返回默认关系最后一次实际变更时间。
func (providerDefault ProviderDefault) UpdatedAt() time.Time {
	return providerDefault.updatedAt
}

// IsValid 判断默认关系是否满足 Provider、账号身份和时间不变量。
func (providerDefault ProviderDefault) IsValid() bool {
	return isCanonicalProviderID(providerDefault.providerID) &&
		providerDefault.accountRef.IsValid() &&
		isCanonicalAccountTime(providerDefault.updatedAt)
}
