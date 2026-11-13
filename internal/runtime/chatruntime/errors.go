package chatruntime

import (
	"errors"
	"fmt"
	"net/http"
)

// Error 表示 Canonical Chat Runtime 领域与接口层的结构化错误。
type Error struct {
	Code       string         `json:"code"`
	StatusCode int            `json:"statusCode,omitempty"`
	Message    string         `json:"message,omitempty"`
	Details    map[string]any `json:"details,omitempty"`
	Cause      error          `json:"-"`
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	if e.Message != "" && e.Message != e.Code {
		return fmt.Sprintf("%s: %s", e.Code, e.Message)
	}
	return e.Code
}

func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

// NewError 创建带 HTTP 状态码和可选诊断详情的 Runtime Error。
func NewError(code string, statusCode int, details map[string]any) *Error {
	if statusCode < 400 || statusCode > 599 {
		statusCode = http.StatusBadRequest
	}
	return &Error{
		Code:       code,
		StatusCode: statusCode,
		Message:    code,
		Details:    cloneMapOrNil(details),
	}
}

// NewErrorWithMessage 创建显式包含诊断消息的 Runtime Error。
func NewErrorWithMessage(code string, statusCode int, message string, details map[string]any) *Error {
	err := NewError(code, statusCode, details)
	if message != "" {
		err.Message = message
	}
	return err
}

// ErrInvalid 创建 400 参数校验错误。
func ErrInvalid(code string) *Error {
	return NewError(code, http.StatusBadRequest, nil)
}

// AsRuntimeError 将任意 error 转换为 *Error。
func AsRuntimeError(err error) (*Error, bool) {
	var target *Error
	if errors.As(err, &target) && target != nil {
		return target, true
	}
	return nil, false
}
