// Package agy 定义 Antigravity Google OAuth 的领域凭据。
package agy

const (
	// ProviderID 是 Antigravity 账号、凭据和运行态使用的规范身份。
	ProviderID = "agy"
)

// AuthKind 是 AGY 当前支持的认证类型。
type AuthKind string

const (
	// AuthKindOAuth 表示 Antigravity consumer Google OAuth。
	AuthKindOAuth AuthKind = "oauth"
)

// String 返回可持久化的稳定认证类型。
func (kind AuthKind) String() string {
	if kind == AuthKindOAuth {
		return string(kind)
	}
	return "unknown"
}

// AuthMethod 是 Antigravity 原生 CLI 接受的 OAuth 模式。
type AuthMethod string

const (
	// AuthMethodConsumer 是原生 CLI 个人 Google 登录使用的唯一枚举值。
	AuthMethodConsumer AuthMethod = "consumer"
)

// String 返回规范原生认证模式。
func (method AuthMethod) String() string {
	if method == AuthMethodConsumer {
		return string(method)
	}
	return "unknown"
}
