// Package pluginerr 定义插件控制面的领域错误。
//
// 错误码与 Node 的 PluginError.code 逐字一致：WebUI、CLI 与测试都按这些字符串分支。
// 放在独立包是为了让传输层、应用层与适配器共享同一套错误，而不引入反向依赖。
package pluginerr

import "errors"

// Error 是带稳定错误码的插件领域错误。
type Error struct {
	Code    string
	Message string
}

// Error 实现 error；Message 为空时回落到 Code（Node PluginError 的默认行为）。
func (err *Error) Error() string {
	if err == nil {
		return ""
	}
	if err.Message == "" {
		return err.Code
	}
	return err.Message
}

// New 创建领域错误。
func New(code string, message string) *Error {
	return &Error{Code: code, Message: message}
}

// From 从错误链里取出领域错误。
func From(err error) (*Error, bool) {
	var coded *Error
	if errors.As(err, &coded) {
		return coded, true
	}
	return nil, false
}
