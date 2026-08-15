package accountsapi

import (
	"encoding/json"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

// nativeImportRequest 是 Provider 原生认证 artifact 导入 DTO。
type nativeImportRequest struct {
	ProviderID string          `json:"provider_id"`
	Artifacts  json.RawMessage `json:"artifacts"`
}

// createAccountRequest 是 Codex、Claude 静态账号创建 DTO。
type createAccountRequest struct {
	ProviderID string               `json:"provider_id"`
	Auth       createAccountAuthDTO `json:"auth"`
}

// createAccountAuthDTO 显式区分 API Key 与 Claude Auth Token。
type createAccountAuthDTO struct {
	Kind      string `json:"kind"`
	APIKey    string `json:"api_key"`
	AuthToken string `json:"auth_token"`
	BaseURL   string `json:"base_url"`
}

// updateAccountRequest 是账号基础资源当前允许修改的字段。
type updateAccountRequest struct {
	Enabled *bool `json:"enabled"`
}

// updateProviderDefaultRequest 是完整替换 Provider 默认账号的 DTO。
type updateProviderDefaultRequest struct {
	AccountRef string `json:"account_ref"`
}

// resolveLaunchSelectionRequest 是一次 Provider CLI 启动账号解析命令。
type resolveLaunchSelectionRequest struct {
	ProviderID   string `json:"provider_id"`
	AccountRef   string `json:"account_ref,omitempty"`
	CLIAccountID *int64 `json:"cli_account_id,omitempty"`
}

// updateCredentialRequest 是静态凭据子资源的完整替换 DTO。
type updateCredentialRequest struct {
	Auth updateCredentialAuthDTO `json:"auth"`
}

// updateCredentialAuthDTO 显式区分 API Key 和 Claude Auth Token。
type updateCredentialAuthDTO struct {
	Kind      string `json:"kind"`
	APIKey    string `json:"api_key"`
	AuthToken string `json:"auth_token"`
	BaseURL   string `json:"base_url"`
}

// updateAccountModelRequest 是单个账号模型人工策略更新 DTO。
type updateAccountModelRequest struct {
	ModelID      string `json:"model_id"`
	ManualPolicy string `json:"manual_policy"`
}

// accountView 是管理 API 允许公开的无敏感账号投影。
type accountView struct {
	AccountRef       string                    `json:"account_ref"`
	ProviderID       string                    `json:"provider_id"`
	CLIAccountID     int64                     `json:"cli_account_id"`
	Enabled          bool                      `json:"enabled"`
	HasCredential    bool                      `json:"has_credential"`
	AuthKind         string                    `json:"auth_kind"`
	AuthMode         string                    `json:"auth_mode"`
	HasProfile       bool                      `json:"has_profile"`
	DisplayName      string                    `json:"display_name"`
	Email            string                    `json:"email"`
	SubscriptionKind string                    `json:"subscription_kind"`
	SubscriptionRaw  string                    `json:"subscription_raw"`
	ProfileUpdatedAt string                    `json:"profile_updated_at,omitempty"`
	ModelSummary     *accountModelSummaryView  `json:"model_summary"`
	UsageSnapshot    *accountUsageSnapshotView `json:"usage_snapshot"`
	CreatedAt        string                    `json:"created_at"`
	UpdatedAt        string                    `json:"updated_at"`
}

// accountModelSummaryView 证明账号已有持久化模型关系，并给出当前有效数量。
type accountModelSummaryView struct {
	StoredCount    int    `json:"stored_count"`
	EffectiveCount int    `json:"effective_count"`
	UpdatedAt      string `json:"updated_at"`
}

// accountUsageSnapshotView 是账号列表内嵌的最近一次成功额度快照。
type accountUsageSnapshotView struct {
	Source     string                  `json:"source"`
	CapturedAt string                  `json:"captured_at"`
	Entries    []accountUsageEntryView `json:"entries"`
}

// accountResponse 是详情、创建和修改共享的成功 envelope。
type accountResponse struct {
	Data accountView `json:"data"`
}

// providerDefaultView 是默认启动账号允许公开的完整关系。
type providerDefaultView struct {
	ProviderID string `json:"provider_id"`
	AccountRef string `json:"account_ref"`
	UpdatedAt  string `json:"updated_at"`
}

// providerDefaultResponse 是默认账号查询和替换共享的成功 envelope。
type providerDefaultResponse struct {
	Data providerDefaultView `json:"data"`
}

// launchSelectionView 是启动账号解析允许公开的非敏感结果。
type launchSelectionView struct {
	ProviderID   string `json:"provider_id"`
	AccountRef   string `json:"account_ref"`
	CLIAccountID int64  `json:"cli_account_id"`
	Source       string `json:"selection_source"`
}

// launchSelectionResponse 是启动账号解析的成功 envelope。
type launchSelectionResponse struct {
	Data launchSelectionView `json:"data"`
}

// accountListResponse 是账号列表及 keyset 分页信息。
type accountListResponse struct {
	Data []accountView `json:"data"`
	Page pageView      `json:"page"`
}

// accountModelView 是账号模型管理 API 的完整非敏感关系。
type accountModelView struct {
	ModelID           string `json:"model_id"`
	UpstreamAvailable bool   `json:"upstream_available"`
	ManualPolicy      string `json:"manual_policy"`
	Effective         bool   `json:"effective"`
	UpdatedAt         string `json:"updated_at"`
}

// accountModelListResponse 是查询、人工维护和刷新共享的成功 envelope。
type accountModelListResponse struct {
	Data []accountModelView `json:"data"`
}

// accountUsageView 是账号最近一次成功额度快照的完整非敏感投影。
type accountUsageView struct {
	AccountRef string                  `json:"account_ref"`
	ProviderID string                  `json:"provider_id"`
	Source     string                  `json:"source"`
	CapturedAt string                  `json:"captured_at"`
	Stale      bool                    `json:"stale"`
	Entries    []accountUsageEntryView `json:"entries"`
}

// accountUsageEntryView 保留 Provider 额度维度和显式可空数值。
type accountUsageEntryView struct {
	LimitID              string  `json:"limit_id"`
	LimitName            string  `json:"limit_name"`
	Bucket               string  `json:"bucket"`
	Kind                 string  `json:"kind"`
	Scope                string  `json:"scope"`
	ScopeKey             string  `json:"scope_key"`
	RemainingBasisPoints *uint16 `json:"remaining_basis_points"`
	Availability         string  `json:"availability"`
	WindowSeconds        *int64  `json:"window_seconds"`
	ResetAt              *string `json:"reset_at"`
}

// accountUsageResponse 是额度查询和刷新共享的成功 envelope。
type accountUsageResponse struct {
	Data accountUsageView `json:"data"`
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
	view := accountView{
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
	modelSummary := overview.ModelSummary()
	if modelSummary.IsKnown() {
		view.ModelSummary = &accountModelSummaryView{
			StoredCount:    modelSummary.StoredCount(),
			EffectiveCount: modelSummary.EffectiveCount(),
			UpdatedAt:      formatTime(modelSummary.UpdatedAt()),
		}
	}
	if usageSnapshot, found := overview.UsageSnapshot(); found {
		view.UsageSnapshot = &accountUsageSnapshotView{
			Source:     usageSnapshot.Source(),
			CapturedAt: formatTime(usageSnapshot.CapturedAt()),
			Entries:    newAccountUsageEntryViews(usageSnapshot.Entries()),
		}
	}
	return view
}

// newAccountViews 保留应用层已经稳定排序的账号顺序。
func newAccountViews(overviews []accountapp.AccountOverview) []accountView {
	views := make([]accountView, 0, len(overviews))
	for _, overview := range overviews {
		views = append(views, newAccountView(overview))
	}
	return views
}

// newProviderDefaultResponse 从领域值对象选择公开字段。
func newProviderDefaultResponse(
	providerDefault accountcore.ProviderDefault,
) providerDefaultResponse {
	return providerDefaultResponse{Data: providerDefaultView{
		ProviderID: providerDefault.ProviderID(),
		AccountRef: providerDefault.AccountRef().String(),
		UpdatedAt:  formatTime(providerDefault.UpdatedAt()),
	}}
}

// newLaunchSelectionResponse 只公开账号稳定身份、数字别名和选择来源。
func newLaunchSelectionResponse(
	selection accountapp.LaunchSelection,
) launchSelectionResponse {
	account := selection.Account()
	return launchSelectionResponse{Data: launchSelectionView{
		ProviderID:   account.ProviderID(),
		AccountRef:   account.Ref().String(),
		CLIAccountID: account.CLIAccountID().Int64(),
		Source:       string(selection.Source()),
	}}
}

// newAccountModelViews 保留应用层按模型 ID 排序的完整关系快照。
func newAccountModelViews(models []accountapp.AccountModel) []accountModelView {
	views := make([]accountModelView, 0, len(models))
	for _, model := range models {
		views = append(views, accountModelView{
			ModelID:           model.ModelID().String(),
			UpstreamAvailable: model.UpstreamAvailable(),
			ManualPolicy:      model.ManualPolicy().String(),
			Effective:         model.Effective(),
			UpdatedAt:         formatTime(model.UpdatedAt()),
		})
	}
	return views
}

// newAccountUsageResponse 从领域快照选择公开额度字段。
func newAccountUsageResponse(result usageapp.ReadResult) accountUsageResponse {
	snapshot := result.Snapshot()
	return accountUsageResponse{Data: accountUsageView{
		AccountRef: snapshot.AccountRef().String(),
		ProviderID: snapshot.ProviderID(),
		Source:     snapshot.Source(),
		CapturedAt: formatTime(snapshot.CapturedAt()),
		Stale:      result.Stale(),
		Entries:    newAccountUsageEntryViews(snapshot.Entries()),
	}}
}

// newAccountUsageEntryViews 让列表内嵌快照和单账号额度资源共享同一 DTO 映射。
func newAccountUsageEntryViews(entries []usagecore.Entry) []accountUsageEntryView {
	views := make([]accountUsageEntryView, 0, len(entries))
	for _, entry := range entries {
		views = append(views, newAccountUsageEntryView(entry))
	}
	return views
}

// newAccountUsageEntryView 保留未知值为 JSON null，而不是伪造零。
func newAccountUsageEntryView(
	entry usagecore.Entry,
) accountUsageEntryView {
	view := accountUsageEntryView{
		LimitID:      entry.LimitID(),
		LimitName:    entry.LimitName(),
		Bucket:       entry.Bucket(),
		Kind:         string(entry.Kind()),
		Scope:        string(entry.Scope()),
		ScopeKey:     entry.ScopeKey(),
		Availability: string(entry.Availability()),
	}
	if remaining, known := entry.RemainingBasisPoints(); known {
		view.RemainingBasisPoints = &remaining
	}
	if windowSeconds := entry.WindowSeconds(); windowSeconds > 0 {
		view.WindowSeconds = &windowSeconds
	}
	if resetAt := entry.ResetAt(); !resetAt.IsZero() {
		formatted := formatTime(resetAt)
		view.ResetAt = &formatted
	}
	return view
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
