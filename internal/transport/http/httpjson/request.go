// Package httpjson 提供 Go HTTP 入站适配器共享的严格 JSON 请求解码。
package httpjson

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
)

var (
	// ErrInvalidDocument 表示请求体不是唯一且符合 DTO 的 JSON 文档。
	ErrInvalidDocument = errors.New("HTTP JSON 请求无效")
	// ErrUnsupportedMediaType 表示写请求没有使用 application/json。
	ErrUnsupportedMediaType = errors.New("HTTP Content-Type 不支持")
	// ErrBodyTooLarge 表示请求体超过调用方声明的上限。
	ErrBodyTooLarge = errors.New("HTTP 请求体过大")
)

// DecodeRequest 严格限制媒体类型、大小、未知字段、重复键和尾随 JSON。
func DecodeRequest(
	response http.ResponseWriter,
	request *http.Request,
	target any,
	maxBytes int64,
) error {
	if response == nil || request == nil || target == nil || maxBytes <= 0 {
		return ErrInvalidDocument
	}
	if !isJSONContentType(request.Header.Get("Content-Type")) {
		return ErrUnsupportedMediaType
	}
	request.Body = http.MaxBytesReader(response, request.Body, maxBytes)
	document, err := io.ReadAll(request.Body)
	if err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			return ErrBodyTooLarge
		}
		return ErrInvalidDocument
	}
	if err := validateUniqueJSONKeys(document); err != nil {
		return ErrInvalidDocument
	}
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return ErrInvalidDocument
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return ErrInvalidDocument
	}
	return nil
}

// validateUniqueJSONKeys 拒绝任意嵌套对象中的重复键和尾随 JSON。
func validateUniqueJSONKeys(document []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.UseNumber()
	if err := consumeUniqueJSONValue(decoder); err != nil {
		return ErrInvalidDocument
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return ErrInvalidDocument
	}
	return nil
}

// consumeUniqueJSONValue 递归读取一个 JSON 值并校验对象键唯一。
func consumeUniqueJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return ErrInvalidDocument
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
		return ErrInvalidDocument
	}
}

// consumeUniqueJSONObject 校验一个对象及其所有子值。
func consumeUniqueJSONObject(decoder *json.Decoder) error {
	seen := make(map[string]struct{})
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return ErrInvalidDocument
		}
		key, valid := token.(string)
		if !valid {
			return ErrInvalidDocument
		}
		if _, duplicated := seen[key]; duplicated {
			return ErrInvalidDocument
		}
		seen[key] = struct{}{}
		if err := consumeUniqueJSONValue(decoder); err != nil {
			return err
		}
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') {
		return ErrInvalidDocument
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
		return ErrInvalidDocument
	}
	return nil
}

// isJSONContentType 允许标准 JSON 及其可选 charset 参数。
func isJSONContentType(value string) bool {
	mediaType, _, err := mime.ParseMediaType(value)
	return err == nil && mediaType == "application/json"
}
