package anthropicmessagesapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/anthropicmessages"
	gatewaycontract "github.com/madou1217/ai_home/internal/contracts/claudegateway"
)

// apiErrorResponse 是 Messages 非流式错误的稳定外层结构。
type apiErrorResponse struct {
	Type  string       `json:"type"`
	Error apiErrorView `json:"error"`
}

// apiErrorView 只暴露 Anthropic 错误类别和固定低敏消息。
type apiErrorView struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

// writeRequestError 映射 HTTP 请求体边界错误。
func writeRequestError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errRequestTooLarge):
		writeAPIError(
			response,
			http.StatusRequestEntityTooLarge,
			"request_too_large",
			"Request body is too large",
		)
	case errors.Is(err, errInvalidContentType),
		errors.Is(err, errUnsupportedContentEncoding):
		writeAPIError(
			response,
			http.StatusUnsupportedMediaType,
			"invalid_request_error",
			"Content type is not supported",
		)
	default:
		writeAPIError(
			response,
			http.StatusBadRequest,
			"invalid_request_error",
			"Invalid request body",
		)
	}
}

// writeDecodeError 映射 Adapter 的安全错误类别，不回显字段值。
func writeDecodeError(response http.ResponseWriter, err error) {
	message := "Invalid request"
	if errors.Is(err, anthropicmessages.ErrUnsupportedFeature) {
		message = "Request feature is not supported"
	}
	writeAPIError(
		response,
		http.StatusBadRequest,
		"invalid_request_error",
		message,
	)
}

// writeExecutionError 在请求仍可写时返回稳定的服务不可用错误。
func writeExecutionError(
	response http.ResponseWriter,
	ctx context.Context,
	_ error,
) {
	if errors.Is(ctx.Err(), context.Canceled) {
		return
	}
	writeAPIError(
		response,
		http.StatusServiceUnavailable,
		"api_error",
		"Inference service is unavailable",
	)
}

// writeCanonicalFailure 保留 Canonical 安全错误类别和消息。
func writeCanonicalFailure(
	response http.ResponseWriter,
	failure inference.ResponseFailure,
) {
	data, err := anthropicmessages.MarshalErrorResponse(failure)
	if err != nil {
		writeAPIError(
			response,
			http.StatusBadGateway,
			"api_error",
			"Invalid upstream failure",
		)
		return
	}
	if failure.Retryable() {
		response.Header().Set(
			gatewaycontract.RetryAccountHeader,
			gatewaycontract.RetryAccountValue,
		)
	}
	writeJSON(response, failureHTTPStatus(failure), data)
}

// failureHTTPStatus 将公开 Anthropic 错误类别映射为 HTTP 状态。
func failureHTTPStatus(failure inference.ResponseFailure) int {
	switch anthropicmessages.ErrorTypeForFailure(failure) {
	case "invalid_request_error":
		return http.StatusBadRequest
	case "authentication_error":
		return http.StatusUnauthorized
	case "permission_error":
		return http.StatusForbidden
	case "not_found_error":
		return http.StatusNotFound
	case "request_too_large":
		return http.StatusRequestEntityTooLarge
	case "rate_limit_error":
		return http.StatusTooManyRequests
	case "overloaded_error":
		return 529
	default:
		return http.StatusInternalServerError
	}
}

// writeStreamFailure 在尚未提交时返回 JSON，提交后追加 Anthropic error SSE。
func writeStreamFailure(
	stream *sseStream,
	response http.ResponseWriter,
	status int,
	errorType string,
	message string,
) {
	if !stream.Committed() {
		writeAPIError(response, status, errorType, message)
		return
	}
	data, err := json.Marshal(apiErrorResponse{
		Type: "error",
		Error: apiErrorView{
			Type:    errorType,
			Message: message,
		},
	})
	if err != nil {
		return
	}
	frame, err := clientprotocol.NewRenderedEvent("error", data)
	if err != nil {
		return
	}
	_ = stream.Write([]clientprotocol.RenderedEvent{frame})
}

// writeAPIError 写入禁止缓存的 Messages JSON 错误。
func writeAPIError(
	response http.ResponseWriter,
	status int,
	errorType string,
	message string,
) {
	data, err := json.Marshal(apiErrorResponse{
		Type: "error",
		Error: apiErrorView{
			Type:    errorType,
			Message: message,
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
