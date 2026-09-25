package geminiapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/gemini"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

// googleErrorEnvelope 是 Google API 的标准错误响应体。
type googleErrorEnvelope struct {
	Error googleErrorDetail `json:"error"`
}

// googleErrorDetail 是 Google 错误明细。
type googleErrorDetail struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Status  string `json:"status"`
}

// writeError 写入禁止缓存的 Google 风格错误。
func writeError(
	response http.ResponseWriter,
	status int,
	statusName string,
	message string,
) {
	data, err := json.Marshal(googleErrorEnvelope{
		Error: googleErrorDetail{
			Code:    status,
			Message: message,
			Status:  statusName,
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

// writeRequestError 把请求体读取错误映射为 Google 风格状态。
func writeRequestError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, inferenceapi.ErrRequestTooLarge):
		writeError(response, http.StatusRequestEntityTooLarge, "INVALID_ARGUMENT", "Request body too large")
	case errors.Is(err, inferenceapi.ErrInvalidContentType),
		errors.Is(err, inferenceapi.ErrUnsupportedContentEncoding):
		writeError(response, http.StatusUnsupportedMediaType, "INVALID_ARGUMENT", "Content type is not supported")
	default:
		writeError(response, http.StatusBadRequest, "INVALID_ARGUMENT", "Invalid request body")
	}
}

// writeDecodeError 把 Gemini Decoder 错误映射为 Google 风格状态。
func writeDecodeError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, gemini.ErrUnsupportedFeature):
		writeError(response, http.StatusBadRequest, "INVALID_ARGUMENT", "Unsupported request feature")
	case errors.Is(err, gemini.ErrModelRequired):
		writeError(response, http.StatusBadRequest, "INVALID_ARGUMENT", "Model is required in the path")
	default:
		writeError(response, http.StatusBadRequest, "INVALID_ARGUMENT", "Invalid request")
	}
}

// writeExecutionError 区分客户端取消与服务不可用。
func writeExecutionError(response http.ResponseWriter, ctx context.Context, err error) {
	if errors.Is(ctx.Err(), context.Canceled) {
		return
	}
	if inferenceapi.IsRequestNotRepresentable(err) {
		writeError(response, http.StatusBadRequest, "INVALID_ARGUMENT", "Request contains a parameter the upstream protocol does not support")
		return
	}
	writeError(response, http.StatusServiceUnavailable, "UNAVAILABLE", "Inference service is unavailable")
}

// writeCanonicalFailure 把 Canonical 失败映射为 Google 风格错误。
func writeCanonicalFailure(
	response http.ResponseWriter,
	failure inference.ResponseFailure,
) {
	status := http.StatusBadGateway
	statusName := "INTERNAL"
	if !failure.Retryable() {
		status = http.StatusBadRequest
		statusName = "INVALID_ARGUMENT"
	}
	writeError(response, status, statusName, failure.SafeMessage())
}
