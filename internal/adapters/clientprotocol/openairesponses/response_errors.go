package openairesponses

import "errors"

var (
	// ErrInvalidEventSequence 表示 Canonical 事件顺序或引用的输出位置无效。
	ErrInvalidEventSequence = errors.New("Canonical 响应事件顺序无效")
	// ErrResponseNotCompleted 表示非流式响应尚未收到明确完成终态。
	ErrResponseNotCompleted = errors.New("Canonical 响应尚未完成")
	// ErrResponseFailed 表示 Canonical 响应以失败终态结束。
	ErrResponseFailed = errors.New("Canonical 响应失败")
	// ErrUnsupportedResponseEvent 表示 Responses 协议无法无损表达指定事件。
	ErrUnsupportedResponseEvent = errors.New("Responses 无法无损表达 Canonical 事件")
)
