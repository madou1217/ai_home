package pluginruntime

import (
	"errors"
	"fmt"

	plugincontract "github.com/madou1217/ai_home/contracts/plugins"
)

// Error 是宿主或传输层给出的稳定错误码（与 Node 端同名）。
type Error struct {
	Code      string
	Message   string
	Supported *plugincontract.ProtocolRange
}

func (e *Error) Error() string {
	if e.Message == "" || e.Message == e.Code {
		return e.Code
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// ErrorCode 让应用层不依赖本包也能读出稳定错误码。
func (e *Error) ErrorCode() string { return e.Code }

// Code 返回错误链中的插件错误码；不是插件错误返回空串。
func Code(err error) string {
	var target *Error
	if errors.As(err, &target) {
		return target.Code
	}
	return ""
}
