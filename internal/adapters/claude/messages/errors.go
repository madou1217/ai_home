// Package messages 实现 Claude 原生 Messages 上游协议适配器。
package messages

import "errors"

var (
	// ErrInvalidDependencies 表示 Adapter 缺少 HTTP Client 或时钟。
	ErrInvalidDependencies = errors.New("Claude Messages Adapter 依赖无效")
	// ErrInvalidInvocation 表示调用不属于 Claude Messages 或凭据类型不受支持。
	ErrInvalidInvocation = errors.New("Claude Messages 调用无效")
	// ErrNativeTransportRequired 表示官方 Claude OAuth 必须保留原生客户端证明。
	ErrNativeTransportRequired = errors.New("Claude OAuth 需要原生 Claude Runtime Transport")
	// ErrUnsupportedRequest 表示 Canonical 请求包含 Messages 无法无损表达的字段。
	ErrUnsupportedRequest = errors.New("Claude Messages 不支持该 Canonical 请求")
	// ErrInvalidUpstreamResponse 表示成功状态响应违反 Messages 协议合同。
	ErrInvalidUpstreamResponse = errors.New("Claude Messages 上游响应无效")
)

// eventSinkError 保留调用方背压错误身份，不把实现细节写入普通日志。
type eventSinkError struct {
	cause error
}

// Error 返回固定低敏说明。
func (eventSinkError) Error() string {
	return "Canonical 事件输出失败"
}

// Cause 返回应原样交还 Coordinator 的背压错误。
func (err eventSinkError) Cause() error {
	return err.cause
}

// upstreamReadError 保存传输错误身份，避免把网络错误文本用于业务分类。
type upstreamReadError struct {
	cause error
}

// Error 返回固定低敏说明。
func (upstreamReadError) Error() string {
	return "读取 Claude Messages 上游流失败"
}

// Unwrap 让调用方仍可识别为无效上游响应。
func (upstreamReadError) Unwrap() error {
	return ErrInvalidUpstreamResponse
}

// Cause 返回只允许交给稳定错误分类器的底层错误。
func (err upstreamReadError) Cause() error {
	return err.cause
}
