// Package codexresetcredit 实现 Codex 额度重置卡的库存读取、幂等消费、故障核对与 app-server 身份核验。
package codexresetcredit

import (
	"errors"
	"net/http"
	"strings"
)

// CodedError 携带机器可读错误码与 HTTP 状态码，对齐原 Node 服务契约。
type CodedError struct {
	Code       string
	Message    string
	StatusCode int
}

func (e *CodedError) Error() string {
	if e == nil {
		return ""
	}
	if strings.TrimSpace(e.Message) != "" {
		return e.Message
	}
	return e.Code
}

func newCodedError(code string, message string, status int) *CodedError {
	if status <= 0 {
		status = http.StatusConflict
	}
	if strings.TrimSpace(message) == "" {
		message = code
	}
	return &CodedError{
		Code:       code,
		Message:    message,
		StatusCode: status,
	}
}

// ExtractError 从任意 error 提取标准错误码、文案与 HTTP 状态码。
func ExtractError(err error, fallbackCode string) (code string, message string, status int) {
	if err == nil {
		return "", "", http.StatusOK
	}
	var coded *CodedError
	if errors.As(err, &coded) && coded != nil {
		c := strings.TrimSpace(coded.Code)
		if c == "" {
			c = fallbackCode
		}
		m := strings.TrimSpace(coded.Message)
		if m == "" {
			m = c
		}
		st := coded.StatusCode
		if st <= 0 {
			st = http.StatusInternalServerError
		}
		return c, m, st
	}
	msg := strings.TrimSpace(err.Error())
	if msg == "" {
		msg = fallbackCode
	}
	return fallbackCode, msg, http.StatusInternalServerError
}
