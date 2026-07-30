package accountsapi

import (
	"encoding/json"
	"net/http"

	"github.com/madou1217/ai_home/internal/transport/http/httpjson"
)

const (
	maxRequestBodyBytes             int64 = 64 * 1024
	maxNativeImportRequestBodyBytes int64 = 1024 * 1024
)

var (
	// errUnsupportedMediaType 表示写请求没有使用 application/json。
	errUnsupportedMediaType = httpjson.ErrUnsupportedMediaType
	// errRequestBodyTooLarge 表示请求体超过账号写接口上限。
	errRequestBodyTooLarge = httpjson.ErrBodyTooLarge
)

// decodeJSONRequest 严格限制媒体类型、大小、未知字段和尾随 JSON。
func decodeJSONRequest(
	response http.ResponseWriter,
	request *http.Request,
	target any,
) error {
	return decodeJSONRequestWithLimit(
		response,
		request,
		target,
		maxRequestBodyBytes,
	)
}

// decodeJSONRequestWithLimit 为较大的官方 artifact 导入保留独立有界上限。
func decodeJSONRequestWithLimit(
	response http.ResponseWriter,
	request *http.Request,
	target any,
	maxBytes int64,
) error {
	return httpjson.DecodeRequest(
		response,
		request,
		target,
		maxBytes,
	)
}

// writeJSON 使用统一安全响应头写入单个 JSON 文档。
func writeJSON(
	response http.ResponseWriter,
	status int,
	payload any,
) {
	document, err := json.Marshal(payload)
	if err != nil {
		document = []byte(
			`{"error":{"code":"internal_error","message":"账号服务内部错误"}}`,
		)
		status = http.StatusInternalServerError
	}
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	_, _ = response.Write(append(document, '\n'))
}

// writeNoContent 使用与 JSON 响应一致的安全缓存头返回空成功响应。
func writeNoContent(response http.ResponseWriter) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(http.StatusNoContent)
}

// writeExportJSON 校验可信输出端口并写入固定文件名的附件响应。
func writeExportJSON(response http.ResponseWriter, document []byte) {
	if !json.Valid(document) {
		writeAPIError(
			response,
			http.StatusInternalServerError,
			"internal_error",
			"账号服务内部错误",
		)
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set(
		"Content-Disposition",
		`attachment; filename="sub2api-data.json"`,
	)
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(http.StatusOK)
	_, _ = response.Write(document)
	_, _ = response.Write([]byte{'\n'})
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
