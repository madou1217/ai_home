package accountsapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
)

const (
	maxRequestBodyBytes             int64 = 64 * 1024
	maxNativeImportRequestBodyBytes int64 = 1024 * 1024
)

var (
	// errInvalidJSONBody 表示请求体不是唯一且符合 DTO 的 JSON 文档。
	errInvalidJSONBody = errors.New("账号 HTTP JSON 请求无效")
	// errUnsupportedMediaType 表示写请求没有使用 application/json。
	errUnsupportedMediaType = errors.New("账号 HTTP Content-Type 不支持")
	// errRequestBodyTooLarge 表示请求体超过账号写接口上限。
	errRequestBodyTooLarge = errors.New("账号 HTTP 请求体过大")
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
	if !isJSONContentType(request.Header.Get("Content-Type")) {
		return errUnsupportedMediaType
	}
	request.Body = http.MaxBytesReader(
		response,
		request.Body,
		maxBytes,
	)
	document, err := io.ReadAll(request.Body)
	if err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			return errRequestBodyTooLarge
		}
		return errInvalidJSONBody
	}
	if err := validateUniqueJSONKeys(document); err != nil {
		return errInvalidJSONBody
	}
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return errInvalidJSONBody
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errInvalidJSONBody
	}
	return nil
}

// validateUniqueJSONKeys 拒绝任意嵌套对象中的重复键和尾随 JSON。
func validateUniqueJSONKeys(document []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.UseNumber()
	if err := consumeUniqueJSONValue(decoder); err != nil {
		return errInvalidJSONBody
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return errInvalidJSONBody
	}
	return nil
}

// consumeUniqueJSONValue 递归读取一个 JSON 值并校验对象键唯一。
func consumeUniqueJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return errInvalidJSONBody
	}
	delim, compound := token.(json.Delim)
	if !compound {
		return nil
	}
	switch delim {
	case '{':
		return consumeUniqueJSONObject(decoder)
	case '[':
		return consumeUniqueJSONArray(decoder)
	default:
		return errInvalidJSONBody
	}
}

// consumeUniqueJSONObject 校验一个对象及其所有子值。
func consumeUniqueJSONObject(decoder *json.Decoder) error {
	seen := make(map[string]struct{})
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return errInvalidJSONBody
		}
		key, valid := token.(string)
		if !valid {
			return errInvalidJSONBody
		}
		if _, duplicated := seen[key]; duplicated {
			return errInvalidJSONBody
		}
		seen[key] = struct{}{}
		if err := consumeUniqueJSONValue(decoder); err != nil {
			return err
		}
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') {
		return errInvalidJSONBody
	}
	return nil
}

// consumeUniqueJSONArray 校验数组中的每个嵌套值。
func consumeUniqueJSONArray(decoder *json.Decoder) error {
	for decoder.More() {
		if err := consumeUniqueJSONValue(decoder); err != nil {
			return err
		}
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim(']') {
		return errInvalidJSONBody
	}
	return nil
}

// isJSONContentType 允许标准 JSON 及其可选 charset 参数。
func isJSONContentType(value string) bool {
	mediaType, _, err := mime.ParseMediaType(value)
	return err == nil && mediaType == "application/json"
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
