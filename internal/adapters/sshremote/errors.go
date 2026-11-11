package sshremote

import "errors"

// 结构化错误码；调用方按码区分认证失败、主机密钥变化与超时。
const (
	CodeInvalidConfig    = "ssh_config_invalid"
	CodeAuthFailed       = "ssh_auth_failed"
	CodeHostKeyMismatch  = "ssh_host_key_mismatch"
	CodeHostKeyRevoked   = "ssh_host_key_revoked"
	CodeTimeout          = "ssh_timeout"
	CodeDialFailed       = "ssh_dial_failed"
	CodeAgentUnavailable = "ssh_agent_unavailable"
	CodeKeyInvalid       = "ssh_key_invalid"
	CodeInvalidPath      = "ssh_path_invalid"
)

// Error 是 SSH 传输层的结构化错误，Code 与调用方的错误分类一一对应。
type Error struct {
	Code    string
	Message string
	// Err 保留底层原因；Error() 会把它拼在 Message 后面，便于探测接口原样回报。
	Err error
}

func (err *Error) Error() string {
	if err == nil {
		return ""
	}
	if err.Err != nil && err.Err.Error() != "" {
		if err.Message == "" {
			return err.Err.Error()
		}
		return err.Message + ": " + err.Err.Error()
	}
	return err.Message
}

// Unwrap 让 errors.Is / errors.As 能穿透到网络或密钥错误。
func (err *Error) Unwrap() error {
	if err == nil {
		return nil
	}
	return err.Err
}

// ErrorCode 取出错误码；不是本包的结构化错误时返回空串。
func ErrorCode(err error) string {
	var target *Error
	if errors.As(err, &target) {
		return target.Code
	}
	return ""
}

func newError(code, message string, cause error) *Error {
	return &Error{Code: code, Message: message, Err: cause}
}
