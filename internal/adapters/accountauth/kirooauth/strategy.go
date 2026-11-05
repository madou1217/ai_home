// Package kirooauth 把 kiro 的令牌刷新接入账号凭据解析器。
//
// 为什么需要：kiro 的 access token 是会过期的（AWS SSO / desktop grant）。Go 承接
// kiro 推理后，如果凭据解析仍走 staticcredential（声明永不刷新），relay 会拿着过期
// token 打上游，得到 403 AccessDeniedException——真机 2026-11-06 就是这样。
//
// 本策略只做协议刷新；写回与 CAS 由 accountcredentials.Resolver 负责。
package kirooauth

import (
	"context"
	"errors"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/kiro"
)

// ProviderID 是本策略支持的 Provider。
const ProviderID = "kiro"

// ErrInvalidRefresher 表示刷新器缺失。
var ErrInvalidRefresher = errors.New("kiro 凭据刷新器缺失")

// Refresher 是协议刷新的最小端口。
type Refresher interface {
	Refresh(ctx context.Context, credential accountapp.Credential) (accountapp.Credential, error)
}

// Strategy 实现 accountcredentials.RefreshStrategy。
type Strategy struct {
	refresher Refresher
}

// New 创建 kiro 刷新策略。
func New(refresher Refresher) (*Strategy, error) {
	if refresher == nil {
		return nil, ErrInvalidRefresher
	}
	return &Strategy{refresher: refresher}, nil
}

// ProviderID 返回 kiro。
func (*Strategy) ProviderID() string { return ProviderID }

// ExpiresAt 返回 access token 的绝对过期时间（来自凭据 payload）。
func (*Strategy) ExpiresAt(credential accountapp.Credential) (time.Time, bool) {
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil || native.ProviderID() != ProviderID {
		return time.Time{}, false
	}
	parsed, err := kiro.ParseCredential(native.Payload())
	if err != nil {
		return time.Time{}, false
	}
	return parsed.ExpiresAt(), true
}

// Refresh 调用官方刷新协议；身份种子不变。
func (strategy *Strategy) Refresh(
	ctx context.Context,
	credential accountapp.Credential,
	refreshedAt time.Time,
) (accountapp.Credential, error) {
	_ = refreshedAt
	if strategy == nil || strategy.refresher == nil {
		return nil, ErrInvalidRefresher
	}
	return strategy.refresher.Refresh(ctx, credential)
}
