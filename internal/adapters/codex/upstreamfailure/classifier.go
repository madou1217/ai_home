// Package upstreamfailure 把 Codex 结构化上游错误映射为统一运行态分类。
package upstreamfailure

import (
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

// Input 是 Codex HTTP 或 SSE observer 提交的低敏错误投影。
type Input struct {
	// StatusCode 是 Codex HTTP 状态；流内错误允许使用 200。
	StatusCode int
	// ErrorType 是 observer 提取的稳定错误类型标识。
	ErrorType string
	// ErrorCode 是 observer 提取的稳定错误代码标识。
	ErrorCode string
	// RetryAfter 是 Codex 给出的有限恢复等待提示。
	RetryAfter time.Duration
}

// Classify 按确定的 Codex 信号优先级返回单一失败分类。
func Classify(input Input) (sharedfailure.Classification, error) {
	response, err := sharedfailure.NormalizeResponseInput(
		sharedfailure.ResponseInput{
			StatusCode: input.StatusCode,
			ErrorType:  input.ErrorType,
			ErrorCode:  input.ErrorCode,
			RetryAfter: input.RetryAfter,
		},
	)
	if err != nil {
		return sharedfailure.Classification{}, err
	}

	kind, carriesRetryAfter := classifyResponse(response)
	retryAfter := time.Duration(0)
	if carriesRetryAfter &&
		response.RetryAfter() <= runtimecore.MaxCooldownHint {
		retryAfter = response.RetryAfter()
	}
	return sharedfailure.NewClassification(kind, retryAfter)
}

// classifyResponse 先处理明确业务代码，再使用 HTTP 状态作为保守兜底。
func classifyResponse(
	response sharedfailure.Response,
) (runtimecore.FailureKind, bool) {
	errorType := response.ErrorType()
	errorCode := response.ErrorCode()

	switch {
	case errorCode == "insufficient_quota":
		return runtimecore.FailureQuotaExhausted, false
	case errorCode == "billing_not_active":
		return runtimecore.FailureBillingBlocked, false
	case errorCode == "invalid_api_key":
		return runtimecore.FailureCredentialRejected, false
	case errorCode == "deactivated_workspace":
		return runtimecore.FailureWorkspaceDeactivated, false
	case errorCode == "model_at_capacity":
		return runtimecore.FailureModelOverloaded, true
	case errorCode == "model_not_found":
		return runtimecore.FailureModelUnsupported, false
	case errorCode == "content_policy_violation":
		return runtimecore.FailureSafetyRejected, false
	case isRateLimit(response.StatusCode(), errorType, errorCode) &&
		response.RetryAfter() > runtimecore.MaxCooldownHint:
		return runtimecore.FailureQuotaExhausted, false
	case isRateLimit(response.StatusCode(), errorType, errorCode):
		return runtimecore.FailureRateLimited, true
	case response.StatusCode() == 401 || response.StatusCode() == 403:
		return runtimecore.FailureCredentialRejected, false
	case response.StatusCode() == 529:
		return runtimecore.FailureModelOverloaded, true
	case response.StatusCode() == 408:
		return runtimecore.FailureRequestTimeout, true
	case response.StatusCode() >= 500:
		return runtimecore.FailureUpstreamUnavailable, true
	case response.StatusCode() == 400 ||
		response.StatusCode() == 422 ||
		errorType == "invalid_request_error":
		return runtimecore.FailureInvalidRequest, false
	case response.StatusCode() == 404:
		return runtimecore.FailureNotFound, false
	default:
		return runtimecore.FailureUnclassified, false
	}
}

// isRateLimit 判断响应是否包含普通速率限制的稳定证据。
func isRateLimit(statusCode int, errorType string, errorCode string) bool {
	return statusCode == 429 ||
		errorType == "rate_limit_error" ||
		errorCode == "rate_limit_exceeded"
}
