// Package tokenrefresh 提供 gemini / grok / cline 三家 OAuth 刷新策略共用的最小端口。
//
// 三家上游协议各不相同（Google JSON、xAI form、Cline 信封），但刷新边界一致：
// 只做协议交换，不读文件、不写库、不做并发合并。到期判断、刷新抑制（30s / 24h）
// 与凭据版本 CAS 统一由 accountcredentials.Resolver 负责，Provider 只需要实现
// Refresher。这样三家就不会各自复制一份写库与冲突处理，也不会出现两个刷新者
// 对同一份会轮换的 Refresh Token 竞争。
package tokenrefresh

import (
	"context"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
)

// Refresher 是三家 OAuth 刷新策略共用的最小接口。
//
// Refresh 只换令牌并返回身份不变的新凭据；ProviderID / ExpiresAt 供调用方判断
// 「这个账号该不该现在刷新」。实现方不得读写存储、不得修改入参凭据。
type Refresher interface {
	// ProviderID 返回策略唯一支持的规范 Provider。
	ProviderID() string
	// ExpiresAt 返回 Access Token 的明确过期时间；不可判定时返回 false。
	ExpiresAt(credential accountapp.Credential) (time.Time, bool)
	// Refresh 调用官方协议换取新令牌，并返回合并后的原生凭据。
	Refresh(ctx context.Context, credential accountapp.Credential) (accountapp.Credential, error)
}

// Strategy 把 Refresher 适配成 accountcredentials.RefreshStrategy。
//
// 适配层只做两件共享的事：校验刷新版本时间，以及复核身份种子未变。身份复核必须
// 集中在这里——三家都是「只替换令牌字段」，一旦上游把刷新发给了另一个账号，凭据
// 文档里的身份字段就会变化，落库等于把两个账号互相串号。
type Strategy struct {
	refresher Refresher
}

var _ accountcredentials.RefreshStrategy = (*Strategy)(nil)

// NewStrategy 创建只读转发的刷新策略。
func NewStrategy(refresher Refresher) (*Strategy, error) {
	if refresher == nil || strings.TrimSpace(refresher.ProviderID()) == "" {
		return nil, accountcredentials.ErrInvalidDependencies
	}
	return &Strategy{refresher: refresher}, nil
}

// ProviderID 返回底层策略的规范 Provider。
func (strategy *Strategy) ProviderID() string {
	if strategy == nil || strategy.refresher == nil {
		return ""
	}
	return strategy.refresher.ProviderID()
}

// ExpiresAt 委托底层策略读取 Access Token 过期时间。
func (strategy *Strategy) ExpiresAt(
	credential accountapp.Credential,
) (time.Time, bool) {
	if strategy == nil || strategy.refresher == nil || credential == nil {
		return time.Time{}, false
	}
	return strategy.refresher.ExpiresAt(credential)
}

// Refresh 在 singleflight 之外执行一次协议刷新，并校验身份不变。
func (strategy *Strategy) Refresh(
	ctx context.Context,
	credential accountapp.Credential,
	refreshedAt time.Time,
) (accountapp.Credential, error) {
	if strategy == nil ||
		strategy.refresher == nil ||
		ctx == nil ||
		credential == nil ||
		refreshedAt.IsZero() ||
		refreshedAt.UnixMilli() <= 0 {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	refreshed, err := strategy.refresher.Refresh(ctx, credential)
	if err != nil {
		return nil, err
	}
	// 身份种子由 Provider 从凭据文档重新派生：这里不信任 Provider 自报的结果，
	// 只用它和原凭据比较。空值同样视为不一致（解码失败的兜底）。
	if refreshed == nil ||
		refreshed.ProviderID() != credential.ProviderID() ||
		refreshed.IdentitySeed() == "" ||
		refreshed.IdentitySeed() != credential.IdentitySeed() {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	return refreshed, nil
}
