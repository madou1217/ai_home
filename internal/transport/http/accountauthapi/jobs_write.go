package accountauthapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
)

// JobWriter 是持久化 OAuth Job 快照的写入端口。
//
// 与 JobReader 分开：读接口不持有写权限，写接口单独注入。Node 仍是 12 类 Provider
// 的登录执行者，它把公开快照推进来，Go 只负责跨重启保存与查询。
type JobWriter interface {
	UpsertJob(ctx context.Context, record accountauth.JobRecord) error
}

// jobRecordInput 是 Node 推送来的公开快照。
type jobRecordInput struct {
	ProviderID   string `json:"provider_id"`
	Purpose      string `json:"purpose"`
	TargetRef    string `json:"target_ref"`
	Status       string `json:"status"`
	CreatedAt    string `json:"created_at"`
	ExpiresAt    string `json:"expires_at"`
	UpdatedAt    string `json:"updated_at"`
	ErrorCode    string `json:"error_code"`
	ErrorMessage string `json:"error_message"`
	// AccountRef 是成功完成后的稳定账号引用；只有 completed 快照携带。
	AccountRef string `json:"account_ref"`
	// CLIAccountID 是成功完成后分配的数字别名；0 表示尚未分配。
	CLIAccountID int64 `json:"cli_account_id"`
	// FinishedAt 是进入终态的时间（RFC3339）；活动快照不携带。
	FinishedAt string `json:"finished_at"`
}

// handleJobUpsert 接收 Node 推送的 Job 公开快照。
//
// 幂等：同一 job_id 反复推送以最后一次为准；时间字段按 RFC3339 解析，缺省用 now。
func (handler *Handler) handleJobUpsert(
	response http.ResponseWriter,
	request *http.Request,
	jobID string,
) {
	if request.Method != http.MethodPut {
		response.Header().Set("Allow", http.MethodPut)
		writeMethodNotAllowed(response)
		return
	}
	if rejectUnexpectedQuery(response, request) {
		return
	}
	if handler.jobWrites == nil {
		writeAPIError(
			response,
			http.StatusServiceUnavailable,
			"job_store_unavailable",
			"OAuth Job 存储不可用",
		)
		return
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, 64*1024))
	if err != nil {
		writeAPIError(response, http.StatusBadRequest, "invalid_request", "请求体无效")
		return
	}
	var input jobRecordInput
	if err := json.Unmarshal(body, &input); err != nil {
		writeAPIError(response, http.StatusBadRequest, "invalid_request", "请求体必须是 JSON")
		return
	}
	record, err := jobRecordFromInput(jobID, input)
	if err != nil {
		writeAPIError(response, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if err := handler.jobWrites.UpsertJob(request.Context(), record); err != nil {
		writeAPIError(response, http.StatusInternalServerError, "job_store_failed", "OAuth Job 写入失败")
		return
	}
	writeJSON(response, http.StatusOK, jobRecordResponse{Data: newJobRecordView(record)})
}

// jobRecordFromInput 校验并归一化推送内容。
func jobRecordFromInput(jobID string, input jobRecordInput) (accountauth.JobRecord, error) {
	purpose := accountauth.Purpose(strings.TrimSpace(input.Purpose))
	if purpose != accountauth.PurposeRegister && purpose != accountauth.PurposeReauth {
		return accountauth.JobRecord{}, errInvalidJobRecord("purpose 必须是 register 或 reauth")
	}
	status := accountauth.Status(strings.TrimSpace(input.Status))
	if !validJobStatus(status) {
		return accountauth.JobRecord{}, errInvalidJobRecord("status 不在允许范围内")
	}
	providerID := strings.TrimSpace(input.ProviderID)
	if providerID == "" {
		return accountauth.JobRecord{}, errInvalidJobRecord("provider_id 不能为空")
	}
	now := time.Now().UTC()
	createdAt, err := parseJobTime(input.CreatedAt, now)
	if err != nil {
		return accountauth.JobRecord{}, errInvalidJobRecord("created_at 无效")
	}
	updatedAt, err := parseJobTime(input.UpdatedAt, createdAt)
	if err != nil {
		return accountauth.JobRecord{}, errInvalidJobRecord("updated_at 无效")
	}
	expiresAt, err := parseJobTime(input.ExpiresAt, time.Time{})
	if err != nil {
		return accountauth.JobRecord{}, errInvalidJobRecord("expires_at 无效")
	}
	finishedAt, err := parseJobTime(input.FinishedAt, time.Time{})
	if err != nil {
		return accountauth.JobRecord{}, errInvalidJobRecord("finished_at 无效")
	}
	if input.CLIAccountID < 0 {
		return accountauth.JobRecord{}, errInvalidJobRecord("cli_account_id 不能为负数")
	}
	accountRef := strings.TrimSpace(input.AccountRef)
	cliAccountID := input.CLIAccountID
	// 账号结果只在终态成立：Node 不会给 pending/processing 推送这三个字段，
	// 这里再归一一次，避免迟到的活动快照把已落库的终态结果带成空值。
	if !status.IsTerminal() {
		accountRef = ""
		cliAccountID = 0
		finishedAt = time.Time{}
	}
	return accountauth.JobRecord{
		ID:           jobID,
		ProviderID:   providerID,
		Purpose:      purpose,
		TargetRef:    strings.TrimSpace(input.TargetRef),
		Status:       status,
		CreatedAt:    createdAt,
		ExpiresAt:    expiresAt,
		UpdatedAt:    updatedAt,
		FinishedAt:   finishedAt,
		AccountRef:   accountRef,
		CLIAccountID: cliAccountID,
		ErrorCode:    strings.TrimSpace(input.ErrorCode),
		ErrorMessage: strings.TrimSpace(input.ErrorMessage),
	}, nil
}

// validJobStatus 只接受 accountauth 已定义的终态与过程态。
func validJobStatus(status accountauth.Status) bool {
	switch status {
	case accountauth.StatusPending,
		accountauth.StatusProcessing,
		accountauth.StatusCompleted,
		accountauth.StatusFailed,
		accountauth.StatusCancelled,
		accountauth.StatusExpired:
		return true
	default:
		return false
	}
}

func parseJobTime(value string, fallback time.Time) (time.Time, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return fallback, nil
	}
	parsed, err := time.Parse(time.RFC3339, trimmed)
	if err != nil {
		return time.Time{}, err
	}
	return parsed.UTC(), nil
}

type errInvalidJobRecord string

func (err errInvalidJobRecord) Error() string { return string(err) }
