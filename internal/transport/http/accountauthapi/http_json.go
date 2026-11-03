package accountauthapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/madou1217/ai_home/internal/transport/http/httpjson"
)

const maxRequestBodyBytes int64 = 32 * 1024

// decodeJSONRequest 使用共享严格策略读取 OAuth Job 请求。
func decodeJSONRequest(
	response http.ResponseWriter,
	request *http.Request,
	target any,
) error {
	return httpjson.DecodeRequest(
		response,
		request,
		target,
		maxRequestBodyBytes,
	)
}

// writeJSON 写入禁止缓存且禁止 MIME 嗅探的 JSON 响应。
func writeJSON(
	response http.ResponseWriter,
	status int,
	payload any,
) {
	document, err := json.Marshal(payload)
	if err != nil {
		document = []byte(
			`{"error":{"code":"internal_error","message":"OAuth Job 服务内部错误"}}`,
		)
		status = http.StatusInternalServerError
	}
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	_, _ = response.Write(append(document, '\n'))
}

// writeAPIError 写入不包含内部错误文本的稳定失败响应。
func writeAPIError(
	response http.ResponseWriter,
	status int,
	code string,
	message string,
) {
	writeJSON(response, status, errorResponse{
		Error: errorView{Code: code, Message: message},
	})
}

// writeRequestDecodeError 把共享 JSON 解码错误映射为固定 HTTP 语义。
func writeRequestDecodeError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, httpjson.ErrUnsupportedMediaType):
		writeAPIError(
			response,
			http.StatusUnsupportedMediaType,
			"unsupported_media_type",
			"请求体必须使用 application/json",
		)
	case errors.Is(err, httpjson.ErrBodyTooLarge):
		writeAPIError(
			response,
			http.StatusRequestEntityTooLarge,
			"request_too_large",
			"请求体超过允许大小",
		)
	default:
		writeAPIError(
			response,
			http.StatusBadRequest,
			"invalid_request",
			"JSON 请求体无效",
		)
	}
}
