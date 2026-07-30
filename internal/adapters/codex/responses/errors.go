// Package responses 实现 Codex 原生 Responses 上游协议适配器。
package responses

import "errors"

var (
	// ErrInvalidDependencies 表示 Adapter 或账号模型权限源缺少必要依赖。
	ErrInvalidDependencies = errors.New("Codex Responses Adapter 依赖无效")
	// ErrInvalidInvocation 表示调用不属于 Codex Responses 或凭据类型不受支持。
	ErrInvalidInvocation = errors.New("Codex Responses 调用无效")
	// ErrUnsupportedRequest 表示 Canonical 请求包含 Codex Responses 无法无损表达的字段。
	ErrUnsupportedRequest = errors.New("Codex Responses 不支持该 Canonical 请求")
	// ErrInvalidUpstreamResponse 表示成功状态响应违反 Responses 协议合同。
	ErrInvalidUpstreamResponse = errors.New("Codex Responses 上游响应无效")
	// ErrModelCatalogUnavailable 表示账号模型目录暂时无法取得可信结果。
	ErrModelCatalogUnavailable = errors.New("Codex 账号模型目录暂不可用")
	// ErrInvalidModelCatalog 表示成功响应不符合账号模型目录合同。
	ErrInvalidModelCatalog = errors.New("Codex 账号模型目录无效")
)

// eventSinkError 保留调用方背压错误身份，但不改变其对外文本。
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

// upstreamReadError 保存传输错误身份，不把网络错误正文暴露到日志。
type upstreamReadError struct {
	cause error
}

// Error 返回固定低敏说明。
func (upstreamReadError) Error() string {
	return "读取 Codex Responses 上游流失败"
}

// Unwrap 让调用方仍可把该错误视为无效上游响应。
func (upstreamReadError) Unwrap() error {
	return ErrInvalidUpstreamResponse
}

// Cause 返回只允许交给稳定错误分类器的底层错误。
func (err upstreamReadError) Cause() error {
	return err.cause
}
