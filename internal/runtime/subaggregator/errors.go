package subaggregator

import (
	"errors"

	"github.com/madou1217/ai_home/internal/runtime/proxykit"
)

func errInvalid(code string, detail ...string) error {
	d := ""
	if len(detail) > 0 {
		d = detail[0]
	}
	return &DomainError{Code: code, Detail: d}
}

func errMessage(code, message string) error {
	return &DomainError{Code: code, Message: message}
}

// AsDomainError 从错误链中提取 DomainError。
func AsDomainError(err error) (*DomainError, bool) {
	var de *DomainError
	if errors.As(err, &de) && de != nil {
		return de, true
	}
	return nil, false
}

// MapErrorStatus 将业务错误码映射为与原 Node 路由一致的 HTTP 状态码。
func MapErrorStatus(code string) int { return proxykit.MapErrorStatus(code) }

func errorCodeOf(err error) string {
	if err == nil {
		return ""
	}
	if de, ok := AsDomainError(err); ok && de.Code != "" {
		return de.Code
	}
	return err.Error()
}
