// Package staticcredential 为「有原生凭据、但 Go 侧没有刷新实现」的 Provider
// 提供只读凭据策略。
//
// 凭据解析器要求每个 Provider 都有一条策略才能解析凭据
// （resolver.readResolutionState 对无策略的 Provider 直接返回
// ErrRefreshStrategyNotFound），而策略存在不必然意味着 Go 能刷新：家族
// （CodeBuddy / WorkBuddy）Token 的刷新由 Node 宿主完成并同步进凭据库，Go 只消费
// 当前值。该策略因此声明「到期不可判定」，解析器永远不会为它发起刷新；Token
// 过期的真实结论由上游 401 经账号运行态（失败分类）接管。
package staticcredential

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
)

// ErrInvalidProvider 表示策略缺少可用的 Provider 标识。
var ErrInvalidProvider = errors.New("静态凭据策略缺少 Provider")

// Strategy 是只消费当前凭据、从不刷新的刷新策略。
type Strategy struct {
	providerID string
}

var _ accountcredentials.RefreshStrategy = (*Strategy)(nil)

// New 创建指定 Provider 的静态凭据策略（Provider 名归一化后必须非空）。
func New(providerID string) (*Strategy, error) {
	normalized := strings.ToLower(strings.TrimSpace(providerID))
	if normalized == "" {
		return nil, ErrInvalidProvider
	}
	return &Strategy{providerID: normalized}, nil
}

// ProviderID 返回策略唯一支持的规范 Provider。
func (strategy *Strategy) ProviderID() string {
	if strategy == nil {
		return ""
	}
	return strategy.providerID
}

// ExpiresAt 始终报告「不可判定」。
//
// Go 没有这些 Provider 的官方刷新协议，报告过期时间只会让解析器走进必然失败的
// 刷新路径（甚至让可用账号在到期窗口内被误判成不可用）。可用性由上游响应说话。
func (*Strategy) ExpiresAt(accountapp.Credential) (time.Time, bool) {
	return time.Time{}, false
}

// Refresh 明确拒绝：策略存在只是解析器的装配要求，不代表 Go 能刷新。
func (*Strategy) Refresh(
	context.Context,
	accountapp.Credential,
	time.Time,
) (accountapp.Credential, error) {
	return nil, accountcredentials.ErrCredentialNotRefreshable
}
