package accounts

import (
	"strings"
	"time"
)

// OAuth 交互式登录的作业窗口（与 Node 的 oauth-pending-state.js 一致）：
// 兜底 5 分钟，浏览器登录 20 分钟（人在网页上操作，5 分钟不够）。
const (
	OauthPendingFallbackStale = 5 * time.Minute
	OauthBrowserJobTTL        = 20 * time.Minute
)

// OauthPendingState 是「账号已创建、OAuth 登录尚未完成」的展示状态。
type OauthPendingState struct {
	Pending bool
	Stale   bool
	Age     time.Duration
	StaleIn time.Duration
}

// IsOauthAuthMode 判断认证方式是否属于 OAuth 家族。
func IsOauthAuthMode(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "oauth", "oauth-browser", "oauth-device", "device", "device-code":
		return true
	default:
		return false
	}
}

// ResolveOauthPendingState 复刻 Node 的判定：未配置、非 API Key 模式且认证方式属 OAuth。
func ResolveOauthPendingState(
	configured bool,
	apiKeyMode bool,
	authMode string,
	updatedAt time.Time,
	now time.Time,
	staleAfter time.Duration,
) OauthPendingState {
	if configured || apiKeyMode || !IsOauthAuthMode(authMode) {
		return OauthPendingState{StaleIn: OauthPendingFallbackStale}
	}
	stale := staleAfter
	if stale <= 0 {
		stale = OauthPendingFallbackStale
	}
	age := stale
	if !updatedAt.IsZero() && !now.Before(updatedAt) {
		age = now.Sub(updatedAt)
	}
	return OauthPendingState{
		Pending: true,
		Stale:   age >= stale,
		Age:     age,
		StaleIn: stale,
	}
}

// ResolveOauthJobDeadline 返回登录作业截止时间；交互式浏览器登录用更长窗口。
func ResolveOauthJobDeadline(createdAt time.Time, authMode string, expiresAt time.Time, staleAfter time.Duration) time.Time {
	if !expiresAt.IsZero() {
		return expiresAt
	}
	if createdAt.IsZero() {
		return time.Time{}
	}
	ttl := staleAfter
	if ttl <= 0 {
		ttl = OauthPendingFallbackStale
		if strings.EqualFold(strings.TrimSpace(authMode), "oauth-browser") {
			ttl = OauthBrowserJobTTL
		}
	}
	return createdAt.Add(ttl)
}
