package accountauthapi

import (
	"errors"
	"net/http"

	"github.com/madou1217/ai_home/application/accountauth"
	accountapp "github.com/madou1217/ai_home/application/accounts"
)

// writeApplicationError 把 OAuth、账号注册和容器错误映射为稳定 HTTP 合同。
func writeApplicationError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, accountauth.ErrUnsupportedProvider):
		writeAPIError(
			response,
			http.StatusUnprocessableEntity,
			"unsupported_provider",
			"当前只支持 Codex 和 Claude OAuth",
		)
	case errors.Is(err, accountauth.ErrActiveJobExists):
		writeAPIError(
			response,
			http.StatusConflict,
			"active_job_exists",
			"该 Provider 已有活动 OAuth Job",
		)
	case errors.Is(err, accountauth.ErrJobCapacity):
		writeAPIError(
			response,
			http.StatusServiceUnavailable,
			"job_capacity_exhausted",
			"OAuth Job 服务暂时繁忙",
		)
	case errors.Is(err, accountauth.ErrJobNotFound):
		writeAPIError(
			response,
			http.StatusNotFound,
			"job_not_found",
			"OAuth Job 不存在",
		)
	case errors.Is(err, accountauth.ErrJobExpired):
		writeAPIError(
			response,
			http.StatusGone,
			"job_expired",
			"OAuth Job 已过期",
		)
	case errors.Is(err, accountauth.ErrJobNotPending):
		writeAPIError(
			response,
			http.StatusConflict,
			"job_not_pending",
			"OAuth Job 已被处理或结束",
		)
	case errors.Is(err, accountauth.ErrInvalidCallback):
		writeAPIError(
			response,
			http.StatusUnprocessableEntity,
			"invalid_callback",
			"OAuth 回调格式无效",
		)
	case errors.Is(err, accountauth.ErrStateMismatch):
		writeAPIError(
			response,
			http.StatusUnprocessableEntity,
			"state_mismatch",
			"OAuth 回调与当前 Job 不匹配",
		)
	case errors.Is(err, accountapp.ErrAccountConflict):
		writeAPIError(
			response,
			http.StatusConflict,
			"account_conflict",
			"该 Provider 账号已经存在",
		)
	case errors.Is(err, accountapp.ErrCLIAccountIDExhausted):
		writeAPIError(
			response,
			http.StatusConflict,
			"cli_account_id_exhausted",
			"Provider 数字别名已经耗尽",
		)
	case errors.Is(err, accountauth.ErrProviderRejected):
		writeAPIError(
			response,
			http.StatusBadGateway,
			"provider_rejected",
			"OAuth Provider 拒绝完成授权",
		)
	case errors.Is(err, accountauth.ErrProviderUnavailable):
		writeAPIError(
			response,
			http.StatusBadGateway,
			"provider_unavailable",
			"OAuth Provider 暂时不可用",
		)
	default:
		writeAPIError(
			response,
			http.StatusInternalServerError,
			"internal_error",
			"OAuth Job 服务内部错误",
		)
	}
}

// writeMethodNotAllowed 返回统一 JSON，而不是 net/http 默认纯文本。
func writeMethodNotAllowed(response http.ResponseWriter) {
	writeAPIError(
		response,
		http.StatusMethodNotAllowed,
		"method_not_allowed",
		"HTTP 方法不受支持",
	)
}
