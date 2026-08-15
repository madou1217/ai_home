package accountcredentials

import (
	"context"
	"errors"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var (
	// ErrInvalidCredentialObservation 表示请求携带的账号、Provider 或观察时间无效。
	ErrInvalidCredentialObservation = errors.New("账号凭据观察无效")
)

// CredentialObservation 只保存请求读取凭据时看到的低敏持久化事实。
//
// 它不是数据库 schema 版本，也不进入账号业务 DTO；updated_at 仅用于终态写入前
// 判断上游结果是否仍属于当前凭据。
type CredentialObservation struct {
	accountRef accountcore.AccountRef
	providerID string
	updatedAt  time.Time
}

// NewCredentialObservation 从同一次持久化凭据快照创建请求级观察。
func NewCredentialObservation(
	snapshot accountapp.CredentialSnapshot,
) (CredentialObservation, error) {
	if !snapshot.IsValid() {
		return CredentialObservation{}, ErrInvalidCredentialObservation
	}
	return CredentialObservation{
		accountRef: snapshot.AccountRef(),
		providerID: snapshot.ProviderID(),
		updatedAt:  snapshot.UpdatedAt(),
	}, nil
}

// AccountRef 返回观察所属的稳定账号身份。
func (observation CredentialObservation) AccountRef() accountcore.AccountRef {
	return observation.accountRef
}

// ProviderID 返回观察所属的规范 Provider。
func (observation CredentialObservation) ProviderID() string {
	return observation.providerID
}

// UpdatedAt 返回读取凭据时看到的 UTC 毫秒时间。
func (observation CredentialObservation) UpdatedAt() time.Time {
	return observation.updatedAt
}

// IsValid 重新检查跨应用边界传递后的低敏观察不变量。
func (observation CredentialObservation) IsValid() bool {
	return observation.accountRef.IsValid() &&
		strings.TrimSpace(observation.providerID) == observation.providerID &&
		observation.providerID != "" &&
		isPersistedObservationTime(observation.updatedAt)
}

// IsCurrentCredentialObservation 只在上游终态即将写运行态时读取当前快照。
func (resolver *Resolver) IsCurrentCredentialObservation(
	ctx context.Context,
	observation CredentialObservation,
) (bool, error) {
	if resolver == nil || resolver.store == nil || ctx == nil || !observation.IsValid() {
		return false, ErrInvalidCredentialObservation
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	snapshot, err := resolver.store.GetCredentialSnapshot(ctx, observation.AccountRef())
	if err != nil {
		return false, err
	}
	if !snapshot.IsValid() {
		return false, ErrInvalidCredentialObservation
	}
	return snapshot.AccountRef() == observation.AccountRef() &&
		snapshot.ProviderID() == observation.ProviderID() &&
		snapshot.UpdatedAt().Equal(observation.UpdatedAt()), nil
}

func isPersistedObservationTime(value time.Time) bool {
	if value.IsZero() || value.Location() != time.UTC || value.UnixMilli() <= 0 {
		return false
	}
	return time.UnixMilli(value.UnixMilli()).UTC().Equal(value)
}
