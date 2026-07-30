// Package openaichatcompletions 实现 OpenAI Chat Completions 客户端协议边界。
//
// 本包只负责线协议 DTO 与 Canonical Contract 的双向转换，不能访问账号、
// Provider 凭据、路由状态、数据库或 HTTP Server 生命周期。
package openaichatcompletions

import (
	"errors"
	"fmt"
)

var (
	// ErrInvalidChatCompletionsRequest 表示请求 JSON 或字段组合无效。
	ErrInvalidChatCompletionsRequest = errors.New("OpenAI Chat Completions 请求无效")
	// ErrUnsupportedFeature 表示合法字段尚无无损 Canonical 语义。
	ErrUnsupportedFeature = errors.New("OpenAI Chat Completions 功能暂不支持")
	// ErrInvalidEventSequence 表示 Canonical 事件缺失、乱序或引用错误。
	ErrInvalidEventSequence = errors.New("Canonical 响应事件顺序无效")
	// ErrUnsupportedResponseEvent 表示 Chat Completions 无法无损表达响应事件。
	ErrUnsupportedResponseEvent = errors.New("Chat Completions 无法表达响应事件")
	// ErrResponseNotCompleted 表示非流式聚合器尚未收到成功终态。
	ErrResponseNotCompleted = errors.New("Chat Completions 响应尚未完成")
	// ErrResponseFailed 表示非流式聚合器收到失败终态。
	ErrResponseFailed = errors.New("Chat Completions 响应失败")
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
	return &DecodeError{kind: ErrInvalidChatCompletionsRequest, field: field}
}

// unsupportedField 创建不会泄露字段值的功能未支持错误。
func unsupportedField(field string) error {
	return &DecodeError{kind: ErrUnsupportedFeature, field: field}
}
