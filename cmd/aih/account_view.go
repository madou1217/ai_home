package main

import "github.com/madou1217/ai_home/internal/host/aihaccount"

// accountEnabledLabel 返回与运行健康状态严格分离的用户启停标签。
func accountEnabledLabel(enabled bool) string {
	if enabled {
		return "enabled"
	}
	return "disabled"
}

// accountAuthLabel 只组合公开认证类型，不读取或显示凭据正文。
func accountAuthLabel(account aihaccount.AccountView) string {
	if !account.HasCredential {
		return "missing"
	}
	if account.AuthMode == "" {
		return account.AuthKind
	}
	return account.AuthKind + "/" + account.AuthMode
}

// accountSubscriptionLabel 优先显示稳定套餐分类，再退回 Provider 原始公开值。
func accountSubscriptionLabel(account aihaccount.AccountView) string {
	if account.SubscriptionKind != "" {
		return account.SubscriptionKind
	}
	if account.SubscriptionRaw != "" {
		return account.SubscriptionRaw
	}
	return "-"
}
