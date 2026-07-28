// Package upstreamfailure 把 Claude 结构化上游错误映射为统一运行态分类。
package upstreamfailure

import (
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

// Input 是 Claude HTTP 或 SSE observer 提交的低敏错误投影。
type Input struct {
	// StatusCode 是 Claude HTTP 状态；流内错误允许使用 200。
	StatusCode int
	// ErrorType 是 observer 提取的稳定错误类型标识。
	ErrorType string
	// ErrorCode 是 observer 提取的稳定错误代码标识。
	ErrorCode string
	// RetryAfter 是 Claude 给出的有限恢复等待提示。
	RetryAfter time.Duration
	// UnifiedRateLimit 表示 Provider 明确确认该限制作用于统一额度窗口。
	UnifiedRateLimit bool
}

// Classify 按确定的 Claude 信号优先级返回单一失败分类。
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

	kind, carriesRetryAfter := classifyResponse(
		response,
		input.UnifiedRateLimit,
	)
	retryAfter := time.Duration(0)
	if carriesRetryAfter &&
		response.RetryAfter() <= runtimecore.MaxCooldownHint {
		retryAfter = response.RetryAfter()
	}
	return sharedfailure.NewClassification(kind, retryAfter)
}

// classifyResponse 先处理 Claude 明确信号，再使用 HTTP 状态保守归类。
func classifyResponse(
	response sharedfailure.Response,
	unifiedRateLimit bool,
) (runtimecore.FailureKind, bool) {
	errorType := response.ErrorType()
	errorCode := response.ErrorCode()
	rateLimited := isRateLimit(response.StatusCode(), errorType)

	switch {
	case errorCode == "oauth_token_revoked":
		return runtimecore.FailureReauthenticationRequired, false
	case errorType == "billing_error":
		return runtimecore.FailureBillingBlocked, false
	case errorType == "quota_error":
		return runtimecore.FailureQuotaExhausted, false
	case errorCode == "deactivated_workspace":
		return runtimecore.FailureWorkspaceDeactivated, false
	case errorCode == "model_not_found":
		return runtimecore.FailureModelUnsupported, false
	case errorCode == "safety_rejected":
		return runtimecore.FailureSafetyRejected, false
	case rateLimited &&
		(unifiedRateLimit ||
			response.RetryAfter() > runtimecore.MaxCooldownHint):
		return runtimecore.FailureQuotaExhausted, false
	case rateLimited:
		return runtimecore.FailureRateLimited, true
	case errorType == "overloaded_error" ||
		response.StatusCode() == 529:
		return runtimecore.FailureModelOverloaded, true
	case errorType == "authentication_error" ||
		errorType == "permission_error" ||
		response.StatusCode() == 401 ||
		response.StatusCode() == 403:
		return runtimecore.FailureCredentialRejected, false
	case errorType == "invalid_request_error" ||
		response.StatusCode() == 400 ||
		response.StatusCode() == 422:
		return runtimecore.FailureInvalidRequest, false
	case errorType == "api_error" ||
		response.StatusCode() >= 500:
		return runtimecore.FailureUpstreamUnavailable, true
	case response.StatusCode() == 408:
		return runtimecore.FailureRequestTimeout, true
	case response.StatusCode() == 404:
		return runtimecore.FailureNotFound, false
	default:
		return runtimecore.FailureUnclassified, false
	}
}

// isRateLimit 判断响应是否包含 Claude 普通速率限制的稳定证据。
func isRateLimit(statusCode int, errorType string) bool {
	return statusCode == 429 || errorType == "rate_limit_error"
}
