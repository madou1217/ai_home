package accountauthapi

import (
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
)

// startJobRequest 是创建 OAuth Job 的唯一输入。
type startJobRequest struct {
	ProviderID       string `json:"provider_id"`
	TargetAccountRef string `json:"target_account_ref,omitempty"`
}

// callbackRequest 是一次性 OAuth 回调输入。
type callbackRequest struct {
	Callback string `json:"callback"`
}

// jobView 是不包含授权 URL、state、PKCE、授权码或 Token 的公开投影。
type jobView struct {
	JobID            string `json:"job_id"`
	ProviderID       string `json:"provider_id"`
	Purpose          string `json:"purpose"`
	TargetAccountRef string `json:"target_account_ref,omitempty"`
	Status           string `json:"status"`
	CreatedAt        string `json:"created_at"`
	ExpiresAt        string `json:"expires_at"`
	FinishedAt       string `json:"finished_at,omitempty"`
	AccountRef       string `json:"account_ref,omitempty"`
	CLIAccountID     int64  `json:"cli_account_id,omitempty"`
	FailureCode      string `json:"failure_code,omitempty"`
}

// startJobView 只在创建响应中增加一次性授权 URL。
type startJobView struct {
	jobView
	AuthorizationURL string `json:"authorization_url"`
}

// jobResponse 是查询、回调和取消共享的成功 envelope。
type jobResponse struct {
	Data jobView `json:"data"`
}

// startJobResponse 是创建 Job 的一次性 URL 交付 envelope。
type startJobResponse struct {
	Data startJobView `json:"data"`
}

// errorResponse 是 OAuth Job API 的稳定错误 envelope。
type errorResponse struct {
	Error errorView `json:"error"`
}

// errorView 只暴露安全错误码和固定消息。
type errorView struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// newJobView 从应用快照选择允许公开的非敏感字段。
func newJobView(job accountauth.Job) jobView {
	return jobView{
		JobID:            job.ID(),
		ProviderID:       job.ProviderID(),
		Purpose:          string(job.Purpose()),
		TargetAccountRef: job.TargetAccountRef().String(),
		Status:           string(job.Status()),
		CreatedAt:        formatTime(job.CreatedAt()),
		ExpiresAt:        formatTime(job.ExpiresAt()),
		FinishedAt:       formatOptionalTime(job.FinishedAt()),
		AccountRef:       job.AccountRef().String(),
		CLIAccountID:     job.CLIAccountID().Int64(),
		FailureCode:      job.FailureCode(),
	}
}

// formatTime 输出跨语言稳定的 UTC RFC3339 时间。
func formatTime(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}

// formatOptionalTime 让活动 Job 的完成时间从 JSON 中省略。
func formatOptionalTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return formatTime(value)
}
