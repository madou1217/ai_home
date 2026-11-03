package oauthutil

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"unicode/utf8"
)

// ErrInvalidJSONResponse 表示 OAuth 上游响应超限、重复键或 JSON 结构无效。
var ErrInvalidJSONResponse = errors.New("OAuth 上游 JSON 响应无效")

// DecodeJSONResponse 有界读取唯一 JSON 文档，并拒绝任意层级的重复对象键。
func DecodeJSONResponse(
	reader io.Reader,
	maxBytes int64,
	target any,
) error {
	if reader == nil || maxBytes <= 0 || target == nil {
		return ErrInvalidJSONResponse
	}
	document, err := io.ReadAll(io.LimitReader(reader, maxBytes+1))
	if err != nil ||
		int64(len(document)) > maxBytes ||
		!utf8.Valid(document) {
		return ErrInvalidJSONResponse
	}
	if err := validateUniqueJSON(document); err != nil {
		return ErrInvalidJSONResponse
	}
	decoder := json.NewDecoder(bytes.NewReader(document))
	if err := decoder.Decode(target); err != nil {
		return ErrInvalidJSONResponse
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return ErrInvalidJSONResponse
	}
	return nil
}

// validateUniqueJSON 校验单个 JSON 值及所有对象键的唯一性。
func validateUniqueJSON(document []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.UseNumber()
	if err := consumeValue(decoder); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return ErrInvalidJSONResponse
	}
	return nil
}

// consumeValue 递归消费一个 JSON 值。
func consumeValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return ErrInvalidJSONResponse
	}
	delim, compound := token.(json.Delim)
	if !compound {
		return nil
	}
	switch delim {
	case '{':
		return consumeObject(decoder)
	case '[':
		return consumeArray(decoder)
	default:
		return ErrInvalidJSONResponse
	}
}

// consumeObject 校验对象键唯一并递归消费字段值。
func consumeObject(decoder *json.Decoder) error {
	seen := make(map[string]struct{})
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return ErrInvalidJSONResponse
		}
		key, valid := token.(string)
		if !valid {
			return ErrInvalidJSONResponse
		}
		if _, duplicated := seen[key]; duplicated {
			return ErrInvalidJSONResponse
		}
		seen[key] = struct{}{}
		if err := consumeValue(decoder); err != nil {
			return err
		}
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') {
		return ErrInvalidJSONResponse
	}
	return nil
}

// consumeArray 递归消费数组元素。
func consumeArray(decoder *json.Decoder) error {
	for decoder.More() {
		if err := consumeValue(decoder); err != nil {
			return err
		}
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim(']') {
		return ErrInvalidJSONResponse
	}
	return nil
}
