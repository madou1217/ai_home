package accountsapi

import (
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
)

// createAccountRequest 是当前只允许 API Key 的账号创建 DTO。
type createAccountRequest struct {
	ProviderID string               `json:"provider_id"`
	Auth       createAccountAuthDTO `json:"auth"`
}

// createAccountAuthDTO 是不会进入响应或日志的 API Key 输入。
type createAccountAuthDTO struct {
	Kind    string `json:"kind"`
	APIKey  string `json:"api_key"`
	BaseURL string `json:"base_url"`
}

// updateAccountRequest 是账号基础资源当前允许修改的字段。
type updateAccountRequest struct {
	Enabled *bool `json:"enabled"`
}

// accountView 是管理 API 允许公开的无敏感账号投影。
type accountView struct {
	AccountRef       string `json:"account_ref"`
	ProviderID       string `json:"provider_id"`
	CLIAccountID     int64  `json:"cli_account_id"`
	Enabled          bool   `json:"enabled"`
	HasCredential    bool   `json:"has_credential"`
	AuthKind         string `json:"auth_kind"`
	AuthMode         string `json:"auth_mode"`
	HasProfile       bool   `json:"has_profile"`
	DisplayName      string `json:"display_name"`
	Email            string `json:"email"`
	SubscriptionKind string `json:"subscription_kind"`
	SubscriptionRaw  string `json:"subscription_raw"`
	ProfileUpdatedAt string `json:"profile_updated_at,omitempty"`
	CreatedAt        string `json:"created_at"`
	UpdatedAt        string `json:"updated_at"`
}

// accountResponse 是详情、创建和修改共享的成功 envelope。
type accountResponse struct {
	Data accountView `json:"data"`
}

// accountListResponse 是账号列表及 keyset 分页信息。
type accountListResponse struct {
	Data []accountView `json:"data"`
	Page pageView      `json:"page"`
}

// pageView 明确下一页游标是否仍然有效。
type pageView struct {
	Limit        int    `json:"limit"`
	HasMore      bool   `json:"has_more"`
	NextAfterRef string `json:"next_after_ref"`
}

// errorResponse 是所有账号 HTTP 错误共享的稳定 envelope。
type errorResponse struct {
	Error errorView `json:"error"`
}

// errorView 只暴露稳定错误码和安全消息。
type errorView struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// newAccountView 从应用投影选择公开字段，不读取 Provider JSON 或凭据。
func newAccountView(overview accountapp.AccountOverview) accountView {
	account := overview.Account()
	return accountView{
		AccountRef:       account.Ref().String(),
		ProviderID:       account.ProviderID(),
		CLIAccountID:     account.CLIAccountID().Int64(),
		Enabled:          account.Enabled(),
		HasCredential:    overview.HasCredential(),
		AuthKind:         overview.AuthKind(),
		AuthMode:         overview.AuthMode(),
		HasProfile:       overview.HasProfile(),
		DisplayName:      overview.DisplayName(),
		Email:            overview.Email(),
		SubscriptionKind: overview.SubscriptionKind(),
		SubscriptionRaw:  overview.SubscriptionRaw(),
		ProfileUpdatedAt: formatOptionalTime(overview.ProfileUpdatedAt()),
		CreatedAt:        formatTime(account.CreatedAt()),
		UpdatedAt:        formatTime(account.UpdatedAt()),
	}
}

// newAccountViews 保留应用层已经稳定排序的账号顺序。
func newAccountViews(overviews []accountapp.AccountOverview) []accountView {
	views := make([]accountView, 0, len(overviews))
	for _, overview := range overviews {
		views = append(views, newAccountView(overview))
	}
	return views
}

// formatTime 输出跨语言稳定的 UTC RFC3339 时间。
func formatTime(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}

// formatOptionalTime 让不存在的 Profile 时间从 JSON 中省略。
func formatOptionalTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return formatTime(value)
}
