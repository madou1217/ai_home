package accounts

import (
	"context"
	"errors"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

var (
	// ErrInvalidProfile 表示公开资料或采集时间不满足应用边界。
	ErrInvalidProfile = errors.New("账号公开资料无效")
	// ErrProfileNotFound 表示账号尚未保存公开资料。
	ErrProfileNotFound = errors.New("账号公开资料不存在")
	// ErrProfileConflict 表示公开资料写入早于或冲突于当前快照。
	ErrProfileConflict = errors.New("账号公开资料冲突")
)

// PublicProfile 是 Provider 公开资料需要实现的最小应用合同。
//
// 该接口只允许非敏感展示和订阅字段，不得暴露 Token、Key、usage 或运行状态。
type PublicProfile interface {
	accountcore.IdentitySource
	IsValid() bool
	DisplayName() string
	Email() string
	SubscriptionKind() string
	SubscriptionRaw() string
}

// ProfileSnapshot 是绑定稳定账号身份和采集时间的公开资料快照。
type ProfileSnapshot struct {
	accountRef accountcore.AccountRef
	profile    PublicProfile
	updatedAt  time.Time
}

// NewProfileSnapshot 校验 Provider、身份和采集时间并创建公开资料快照。
func NewProfileSnapshot(
	catalog *providers.Catalog,
	profile PublicProfile,
	updatedAt time.Time,
) (ProfileSnapshot, error) {
	if catalog == nil || profile == nil || !profile.IsValid() {
		return ProfileSnapshot{}, ErrInvalidProfile
	}
	canonicalProviderID, found := catalog.CanonicalID(profile.ProviderID())
	if !found || canonicalProviderID != profile.ProviderID() {
		return ProfileSnapshot{}, ErrInvalidProfile
	}
	accountRef, err := accountcore.DeriveAccountRef(profile)
	if err != nil {
		return ProfileSnapshot{}, ErrInvalidProfile
	}
	normalizedTime, err := normalizePersistedTime(updatedAt)
	if err != nil {
		return ProfileSnapshot{}, ErrInvalidProfile
	}
	return ProfileSnapshot{
		accountRef: accountRef,
		profile:    profile,
		updatedAt:  normalizedTime,
	}, nil
}

// AccountRef 返回公开资料绑定的稳定账号身份。
func (snapshot ProfileSnapshot) AccountRef() accountcore.AccountRef {
	return snapshot.accountRef
}

// Profile 返回 Provider 公开资料值。
func (snapshot ProfileSnapshot) Profile() PublicProfile {
	return snapshot.profile
}

// UpdatedAt 返回 UTC 毫秒精度的资料采集时间。
func (snapshot ProfileSnapshot) UpdatedAt() time.Time {
	return snapshot.updatedAt
}

// ProfileStore 是公开资料独立写入和按需读取所需的持久化端口。
type ProfileStore interface {
	// UpsertProfile 只接受不早于当前版本的公开资料。
	UpsertProfile(ctx context.Context, snapshot ProfileSnapshot) error
	// GetProfile 按稳定账号身份读取并重新校验 Provider 公开资料。
	GetProfile(ctx context.Context, accountRef accountcore.AccountRef) (ProfileSnapshot, error)
}
