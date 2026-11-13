package subaggregator

import (
	"errors"
	"strings"
)

// DomainError 描述订阅聚合与节点池领域的结构化错误。
type DomainError struct {
	Code    string `json:"error"`
	Detail  string `json:"detail,omitempty"`
	Message string `json:"message,omitempty"`
}

func (e *DomainError) Error() string {
	if e == nil {
		return ""
	}
	if e.Message != "" {
		return e.Message
	}
	return e.Code
}

// HTTPStatus 返回错误码对应的 HTTP 状态码。
func (e *DomainError) HTTPStatus() int {
	if e == nil {
		return 500
	}
	return MapErrorStatus(e.Code)
}

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
func MapErrorStatus(code string) int {
	c := strings.TrimSpace(code)
	if c == "" {
		return 500
	}
	if c == "request_body_too_large" {
		return 413
	}
	if c == "local_scan_requires_local_request" {
		return 403
	}
	if strings.HasSuffix(c, "_not_found") {
		return 404
	}
	switch c {
	case "subscription_changed_during_sync",
		"proxy_store_busy",
		"subscription_disabled",
		"subscription_source_required":
		return 409
	case "subscription_http_error",
		"subscription_host_resolution_failed",
		"aggregator_rule_set_fetch_failed":
		return 502
	case "subscription_url_required",
		"subscription_url_too_long",
		"subscription_url_credentials_not_allowed",
		"subscription_url_host_blocked",
		"subscription_url_port_blocked",
		"subscription_redirect_limit_exceeded",
		"subscription_redirect_missing_location",
		"subscription_response_too_large",
		"subscription_content_too_large",
		"no_valid_proxy_nodes_found",
		"probe_address_blocked",
		"empty_profile_name",
		"relay_no_compatible_nodes",
		"relay_port_exhausted":
		return 422
	}
	if strings.HasPrefix(c, "subscription_fetch_") {
		return 502
	}
	if strings.HasPrefix(c, "invalid_") ||
		strings.HasPrefix(c, "unsupported_") ||
		strings.HasPrefix(c, "too_many_") ||
		strings.HasPrefix(c, "missing_") ||
		strings.HasPrefix(c, "duplicate_") ||
		strings.HasPrefix(c, "reserved_") {
		return 422
	}
	return 500
}

func errorCodeOf(err error) string {
	if err == nil {
		return ""
	}
	if de, ok := AsDomainError(err); ok && de.Code != "" {
		return de.Code
	}
	return err.Error()
}
