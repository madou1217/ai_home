package sshhost

import "errors"

// ConfigError 是 SSH 连接配置校验失败的结构化错误。
type ConfigError struct {
	Code string
}

func (err *ConfigError) Error() string {
	if err == nil {
		return ""
	}
	return err.Code
}

// AsConfigError 便于调用方用 errors.As 取出错误码。
func AsConfigError(err error) (*ConfigError, bool) {
	var configErr *ConfigError
	if errors.As(err, &configErr) {
		return configErr, true
	}
	return nil, false
}
