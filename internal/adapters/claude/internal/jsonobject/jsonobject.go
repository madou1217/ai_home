// Package jsonobject 提供 Claude 原生 JSON Adapter 共用的严格对象解析。
package jsonobject

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
)

// Decode 解析一个 JSON 对象，并拒绝重复键和尾随值。
func Decode(data []byte) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return nil, errors.New("不是 JSON 对象")
	}
	fields := make(map[string]json.RawMessage)
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, errors.New("JSON 对象键无效")
		}
		if _, duplicate := fields[key]; duplicate {
			return nil, errors.New("JSON 对象键重复")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		fields[key] = append(json.RawMessage(nil), value...)
	}
	end, err := decoder.Token()
	if err != nil || end != json.Delim('}') {
		return nil, errors.New("JSON 对象未结束")
	}
	if err := EnsureEOF(decoder); err != nil {
		return nil, err
	}
	return fields, nil
}

// DecodeExact 解析字段集合固定的 JSON 对象。
func DecodeExact(data []byte, required ...string) (map[string]json.RawMessage, error) {
	return DecodeShape(data, required)
}

// DecodeShape 解析同时包含必填字段和可选字段的严格 JSON 对象。
func DecodeShape(data []byte, required []string, optional ...string) (map[string]json.RawMessage, error) {
	fields, err := Decode(data)
	if err != nil {
		return nil, err
	}
	wanted := make(map[string]struct{}, len(required)+len(optional))
	for _, key := range required {
		wanted[key] = struct{}{}
	}
	for _, key := range optional {
		wanted[key] = struct{}{}
	}
	for key := range fields {
		if _, ok := wanted[key]; !ok {
			return nil, errors.New("出现未知字段")
		}
	}
	for _, key := range required {
		if _, ok := fields[key]; !ok {
			return nil, errors.New("缺少字段")
		}
	}
	return fields, nil
}

// EnsureEOF 要求一个 JSON 值后只剩空白。
func EnsureEOF(decoder *json.Decoder) error {
	var trailing any
	err := decoder.Decode(&trailing)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return errors.New("存在尾随 JSON")
	}
	return err
}

// IsNull 判断 RawMessage 是否为 JSON null。
func IsNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}
