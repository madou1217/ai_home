package aihserver

import (
	"context"

	coreclientkeys "github.com/madou1217/ai_home/core/clientkeys"
)

// providerAllowedForClientKey 判断当前请求所属 Key 的账号池白名单是否放行该 Provider。
//
// 限制由鉴权边界写入请求上下文；未携带限制时一律放行。账号来源据此在征召前
// 跳过白名单外的 Provider，避免透传通道绕过 Canonical 的同一判定。
func providerAllowedForClientKey(ctx context.Context, providerID string) bool {
	limits, ok := coreclientkeys.LimitsFromContext(ctx)
	if !ok {
		return true
	}
	return limits.AllowsProvider(providerID)
}
