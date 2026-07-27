// Package codex 定义 Codex 账号认证的纯领域模型。
//
// 该包只负责认证类型、稳定身份和凭证不变量，不依赖数据库、Server 或文件适配器。
// OAuth claim 只投影可信登录流程已取得的本地凭证，不执行网络请求或 JWT 签名验证，
// 因此这些 claim 不能作为本地授权证明；不可信导入必须先在集成边界完成验签。
package codex

import "fmt"

// AuthKind 表示 Codex 账号唯一允许的认证类型。
type AuthKind string

const (
	// AuthKindOAuth 表示 ChatGPT OAuth 账号。
	AuthKindOAuth AuthKind = "oauth"
	// AuthKindAPIKey 表示 OpenAI 兼容 API Key 账号。
	AuthKindAPIKey AuthKind = "api_key"
)

// String 返回稳定且不包含凭证的认证类型文本。
func (kind AuthKind) String() string {
	switch kind {
	case AuthKindOAuth:
		return string(AuthKindOAuth)
	case AuthKindAPIKey:
		return string(AuthKindAPIKey)
	default:
		return "unknown"
	}
}

// Auth 是 Codex 认证的封闭领域接口。
//
// 未导出的 seal 方法确保只有本包能够增加认证变体，避免调用方绕过构造器不变量。
type Auth interface {
	fmt.Stringer
	Kind() AuthKind
	IdentitySeed() string
	Summary() AuthSummary
	GoString() string
	seal()
}

// AuthSummary 是不包含 Token 或 API Key 的只读认证摘要。
type AuthSummary struct {
	// Kind 是认证类型。
	Kind AuthKind
	// UserID 是 OAuth 稳定用户 ID；API Key 账号为空。
	UserID string
	// AccountID 是 OAuth 工作区 ID；个人账号固定为 personal。
	AccountID string
	// PlanType 是 OAuth 套餐类型。
	PlanType string
	// PlanFamily 是 OAuth 套餐的稳定领域归类。
	PlanFamily PlanFamily
	// IsFedRAMP 表示 OAuth 账号是否属于 FedRAMP 环境。
	IsFedRAMP bool
	// BaseURL 是 API Key 账号规范化后的上游地址。
	BaseURL string
	// AccessExpiresAtMS 是 Access Token 的可选过期时间；零表示未知。
	AccessExpiresAtMS int64
	// RefreshedAtMS 是 OAuth 凭证最近成功刷新的毫秒时间戳。
	RefreshedAtMS int64
}

// String 返回适合日志展示的脱敏摘要。
func (summary AuthSummary) String() string {
	switch summary.Kind {
	case AuthKindOAuth:
		return fmt.Sprintf(
			"codex.AuthSummary{kind=%s,user=%s,account=%s,plan=%s,plan_family=%s,fedramp=%t,access_expires_at_ms=%d,refreshed_at_ms=%d}",
			summary.Kind,
			summary.UserID,
			summary.AccountID,
			summary.PlanType,
			summary.PlanFamily,
			summary.IsFedRAMP,
			summary.AccessExpiresAtMS,
			summary.RefreshedAtMS,
		)
	case AuthKindAPIKey:
		return fmt.Sprintf(
			"codex.AuthSummary{kind=%s,base_url=%s}",
			summary.Kind,
			summary.BaseURL,
		)
	default:
		return "codex.AuthSummary{kind=unknown}"
	}
}

// GoString 确保 %#v 也使用脱敏摘要。
func (summary AuthSummary) GoString() string {
	return summary.String()
}

// secretValue 包装进程内明文凭证，防止正常格式化直接输出原始值。
type secretValue string

// newSecretValue 使用私有指针保存凭证，使 fmt 的异常反射路径也只能看到地址。
func newSecretValue(raw string) *secretValue {
	value := secretValue(raw)
	return &value
}

// reveal 仅供显式凭证访问器返回原始值。
func (value *secretValue) reveal() string {
	if value == nil {
		return ""
	}
	return string(*value)
}

// String 对任何普通格式化请求返回固定脱敏文本。
func (secretValue) String() string {
	return "<redacted>"
}

// GoString 对 %#v 格式化请求返回固定脱敏文本。
func (secretValue) GoString() string {
	return "<redacted>"
}

// formatAuthSummary 忽略调用方 verb，把所有正常 fmt 路径统一为安全摘要。
func formatAuthSummary(state fmt.State, summary AuthSummary) {
	_, _ = state.Write([]byte(summary.String()))
}
