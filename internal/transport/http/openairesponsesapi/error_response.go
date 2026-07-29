package openairesponsesapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/openairesponses"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

// apiErrorResponse 是 OpenAI API 错误的稳定外层结构。
type apiErrorResponse struct {
	Error apiErrorView `json:"error"`
}

// apiErrorView 只暴露低敏错误类别、稳定代码和安全消息。
type apiErrorView struct {
	Message string  `json:"message"`
	Type    string  `json:"type"`
	Param   *string `json:"param"`
	Code    string  `json:"code"`
}

// writeRequestError 映射 HTTP 请求体边界错误。
func writeRequestError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, inferenceapi.ErrRequestTooLarge):
		writeAPIError(
			response,
			http.StatusRequestEntityTooLarge,
			"request_too_large",
			"request_too_large",
			"Request body is too large",
		)
	case errors.Is(err, inferenceapi.ErrInvalidContentType),
		errors.Is(err, inferenceapi.ErrUnsupportedContentEncoding):
		writeAPIError(
			response,
			http.StatusUnsupportedMediaType,
			"invalid_request_error",
			"unsupported_media_type",
			"Content type is not supported",
		)
	default:
		writeAPIError(
			response,
			http.StatusBadRequest,
			"invalid_request_error",
			"invalid_request_body",
			"Invalid request body",
		)
	}
}

// writeDecodeError 映射 Adapter 的安全错误类别，不回显字段值。
func writeDecodeError(response http.ResponseWriter, err error) {
	message := "Invalid request"
	code := "invalid_request"
	if errors.Is(err, openairesponses.ErrUnsupportedFeature) {
		message = "Request feature is not supported"
		code = "unsupported_feature"
	}
	writeAPIError(
		response,
		http.StatusBadRequest,
		"invalid_request_error",
		code,
		message,
	)
}

// writeExecutionError 在请求仍可写时返回稳定的服务不可用错误。
func writeExecutionError(
	response http.ResponseWriter,
	ctx context.Context,
) {
	if errors.Is(ctx.Err(), context.Canceled) {
		return
	}
	writeAPIError(
		response,
		http.StatusServiceUnavailable,
		"server_error",
		"inference_unavailable",
		"Inference service is unavailable",
	)
}

// writeCanonicalFailure 保留 Canonical 安全错误类别和消息。
func writeCanonicalFailure(
	response http.ResponseWriter,
	failure inference.ResponseFailure,
) {
	if !failure.IsValid() {
		writeAPIError(
			response,
			http.StatusBadGateway,
			"server_error",
			"invalid_upstream_failure",
			"Invalid upstream failure",
		)
		return
	}
	writeAPIError(
		response,
		failureHTTPStatus(failure),
		failureErrorType(failure),
		failure.Code(),
		failure.SafeMessage(),
	)
}

// failureErrorType 把内部稳定代码映射为 OpenAI 公开错误类别。
func failureErrorType(failure inference.ResponseFailure) string {
	switch failureHTTPStatus(failure) {
	case http.StatusBadRequest, http.StatusRequestEntityTooLarge:
		return "invalid_request_error"
	case http.StatusUnauthorized:
		return "authentication_error"
	case http.StatusForbidden:
		return "permission_error"
	case http.StatusNotFound:
		return "not_found_error"
	case http.StatusTooManyRequests:
		return "rate_limit_error"
	default:
		return "server_error"
	}
}

// failureHTTPStatus 将 Canonical 失败类别映射为 OpenAI HTTP 状态。
func failureHTTPStatus(failure inference.ResponseFailure) int {
	switch failure.Code() {
	case "invalid_request_error",
		string(runtimecore.FailureInvalidRequest),
		string(runtimecore.FailureModelUnsupported):
		return http.StatusBadRequest
	case "authentication_error",
		string(runtimecore.FailureCredentialRejected),
		string(runtimecore.FailureReauthenticationRequired):
		return http.StatusUnauthorized
	case "permission_error",
		string(runtimecore.FailureBillingBlocked),
		string(runtimecore.FailureWorkspaceDeactivated),
		string(runtimecore.FailureRegionUnsupported),
		string(runtimecore.FailureSafetyRejected):
		return http.StatusForbidden
	case "not_found_error",
		string(runtimecore.FailureNotFound):
		return http.StatusNotFound
	case "request_too_large":
		return http.StatusRequestEntityTooLarge
	case "rate_limit_error",
		string(runtimecore.FailureRateLimited),
		string(runtimecore.FailureQuotaExhausted):
		return http.StatusTooManyRequests
	case string(runtimecore.FailureRequestTimeout):
		return http.StatusGatewayTimeout
	case string(runtimecore.FailureModelOverloaded),
		string(runtimecore.FailureUpstreamUnavailable):
		return http.StatusServiceUnavailable
	default:
		return http.StatusBadGateway
	}
}

// writeAPIError 写入禁止缓存的 OpenAI JSON 错误。
func writeAPIError(
	response http.ResponseWriter,
	status int,
	errorType string,
	code string,
	message string,
) {
	data, err := json.Marshal(apiErrorResponse{
		Error: apiErrorView{
			Message: message,
			Type:    errorType,
			Code:    code,
		},
	})
	if err != nil {
		http.Error(response, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(response, status, data)
}

// writeJSON 写入禁止 MIME 猜测和缓存的完整 JSON。
func writeJSON(response http.ResponseWriter, status int, data []byte) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	_, _ = response.Write(data)
}
