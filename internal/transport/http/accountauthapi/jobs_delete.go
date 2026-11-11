package accountauthapi

import (
	"context"
	"net/http"
)

// JobRemover 是持久化 OAuth Job 快照的删除端口。
//
// 与取消（DELETE /v1/management/account-auth-jobs/{id}）刻意分开：取消是状态迁移，
// 需要 Job 仍在进程内等待回调；这里删除的是 aih.db 里的历史快照，
// 不触碰任何正在执行的 OAuth Flow。
type JobRemover interface {
	// DeleteJob 删除单条快照，第二个返回值表示删除前是否存在。
	DeleteJob(ctx context.Context, jobID string) (bool, error)
}

// handleJobDelete 物理删除一条持久化 Job 快照。
//
// 成功返回 204；不存在与已清理都返回 404，调用方不需要区分内部历史。
// 删除活动 Job 不会阻止它下一次状态迁移重新落库，因此这个接口只用于管理面清理，
// 不作为取消登录的入口。
func (handler *Handler) handleJobDelete(
	response http.ResponseWriter,
	request *http.Request,
	jobID string,
) {
	if rejectUnexpectedQuery(response, request) {
		return
	}
	if handler.jobDeletes == nil {
		writeAPIError(
			response,
			http.StatusServiceUnavailable,
			"job_store_unavailable",
			"OAuth Job 存储不可用",
		)
		return
	}
	deleted, err := handler.jobDeletes.DeleteJob(request.Context(), jobID)
	if err != nil {
		writeAPIError(
			response,
			http.StatusInternalServerError,
			"internal_error",
			"OAuth Job 快照删除失败",
		)
		return
	}
	if !deleted {
		writeAPIError(
			response,
			http.StatusNotFound,
			"oauth_job_not_found",
			"OAuth Job 不存在",
		)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}
