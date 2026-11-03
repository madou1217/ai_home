// Package openairesponses 实现 OpenAI Responses 客户端协议边界。
//
// 本包只负责线协议 DTO 与 Canonical Contract 的双向转换，不能访问账号、
// Provider 凭据、路由状态、数据库或 HTTP Server 生命周期。
package openairesponses

import (
	"errors"
	"fmt"
)

var (
	// ErrInvalidResponsesRequest 表示客户端 JSON 或字段组合不符合受支持合同。
	ErrInvalidResponsesRequest = errors.New("OpenAI Responses 请求无效")
	// ErrUnsupportedFeature 表示字段合法，但尚未建立无损的 Canonical 语义。
	ErrUnsupportedFeature = errors.New("OpenAI Responses 功能暂不支持")
)

// DecodeError 是不包含请求正文和敏感值的低敏 Decoder 错误。
type DecodeError struct {
	kind  error
	field string
}

// Error 返回只包含错误类别和字段路径的安全说明。
func (decodeError *DecodeError) Error() string {
	return fmt.Sprintf("%v: %s", decodeError.kind, decodeError.field)
}

// Unwrap 允许调用方使用 errors.Is 判断错误类别。
func (decodeError *DecodeError) Unwrap() error {
	return decodeError.kind
}

// invalidField 创建不会泄露字段值的请求无效错误。
func invalidField(field string) error {
	return &DecodeError{kind: ErrInvalidResponsesRequest, field: field}
}

// unsupportedField 创建不会泄露字段值的功能未支持错误。
func unsupportedField(field string) error {
	return &DecodeError{kind: ErrUnsupportedFeature, field: field}
}
