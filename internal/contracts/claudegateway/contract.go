// Package claudegateway 定义 AIH Server 与本地 Claude CLI 代理的私有 HTTP 合同。
package claudegateway

const (
	// SelectionPath 为单次 Messages 请求选择账号和传输方式。
	SelectionPath = "/v1/claude-relay-leases"
	// RetryAccountHeader 表示响应尚未向 CLI 提交，可以安全征召另一个账号。
	RetryAccountHeader = "X-AIH-Retry-Account"
	// RetryAccountValue 是避免布尔值歧义的唯一允许值。
	RetryAccountValue = "true"
	// TransportCanonical 表示 Server 已固定一个可由 Canonical Adapter 使用的账号。
	TransportCanonical = "canonical"
	// TransportNativeOAuth 表示 Server 已签发账号绑定的原生 OAuth 租约。
	TransportNativeOAuth = "native_oauth"
)

// SelectionRequest 携带真实模型和可选固定账号，不包含 Prompt 或凭据。
type SelectionRequest struct {
	Model               string   `json:"model"`
	AccountRef          string   `json:"account_ref,omitempty"`
	ExcludedAccountRefs []string `json:"excluded_account_refs,omitempty"`
}

// SelectionResponse 包装一次不含长期凭据的传输选择。
type SelectionResponse struct {
	Data SelectionView `json:"data"`
}

// SelectionView 是 CLI 代理执行 Server 决策所需的最小投影。
type SelectionView struct {
	Transport  string `json:"transport"`
	AccountRef string `json:"account_ref"`
	Token      string `json:"token,omitempty"`
	ExpiresAt  string `json:"expires_at,omitempty"`
}

// ErrorResponse 是私有选择入口的稳定失败结构。
type ErrorResponse struct {
	Error ErrorView `json:"error"`
}

// ErrorView 只包含固定错误码和低敏消息。
type ErrorView struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
