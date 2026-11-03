package codexoauth

import (
	"crypto/subtle"
	"net/url"
	"strings"

	"github.com/madou1217/ai_home/application/accountauth"
)

const maxCallbackBytes = 16 * 1024

// parseCallback 只接受官方 localhost redirect 的完整 URL。
func parseCallback(
	rawCallback string,
	expectedRedirect string,
	expectedState string,
) (string, error) {
	if rawCallback == "" || len(rawCallback) > maxCallbackBytes {
		return "", accountauth.ErrInvalidCallback
	}
	callback, err := url.Parse(rawCallback)
	expected, expectedErr := url.Parse(expectedRedirect)
	if err != nil ||
		expectedErr != nil ||
		callback.User != nil ||
		callback.Fragment != "" ||
		!sameCallbackTarget(callback, expected) {
		return "", accountauth.ErrInvalidCallback
	}
	query, err := url.ParseQuery(callback.RawQuery)
	if err != nil {
		return "", accountauth.ErrInvalidCallback
	}
	if !onlyAllowedKeys(query, "code", "state", "error", "error_description") {
		return "", accountauth.ErrInvalidCallback
	}
	state, valid := singleValue(query, "state")
	if !valid || !constantTimeEqual(state, expectedState) {
		return "", accountauth.ErrStateMismatch
	}
	if providerError, found := singleOptionalValue(query, "error"); !found {
		return "", accountauth.ErrInvalidCallback
	} else if providerError != "" {
		return "", accountauth.ErrProviderRejected
	}
	code, valid := singleValue(query, "code")
	if !valid || !validSecret(code) {
		return "", accountauth.ErrInvalidCallback
	}
	return code, nil
}

// sameCallbackTarget 比较 scheme、host 和 path，不接受重定向到其他目标。
func sameCallbackTarget(callback *url.URL, expected *url.URL) bool {
	return strings.EqualFold(callback.Scheme, expected.Scheme) &&
		strings.EqualFold(callback.Host, expected.Host) &&
		callback.Path == expected.Path
}

// onlyAllowedKeys 拒绝回调中的历史兼容字段和重复键。
func onlyAllowedKeys(query url.Values, allowed ...string) bool {
	accepted := make(map[string]struct{}, len(allowed))
	for _, key := range allowed {
		accepted[key] = struct{}{}
	}
	for key, values := range query {
		if _, found := accepted[key]; !found || len(values) != 1 {
			return false
		}
	}
	return true
}

// singleValue 读取唯一且非空的回调字段。
func singleValue(query url.Values, key string) (string, bool) {
	values, found := query[key]
	return firstValue(values, found, false)
}

// singleOptionalValue 读取可缺失但不能重复的回调字段。
func singleOptionalValue(query url.Values, key string) (string, bool) {
	values, found := query[key]
	return firstValue(values, found, true)
}

// firstValue 实现必填和可选字段共享的唯一值校验。
func firstValue(values []string, found bool, optional bool) (string, bool) {
	if !found {
		return "", optional
	}
	if len(values) != 1 {
		return "", false
	}
	if !optional && values[0] == "" {
		return "", false
	}
	return values[0], true
}

// constantTimeEqual 避免 state 比较暴露可利用的短路时序。
func constantTimeEqual(left string, right string) bool {
	if len(left) != len(right) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

// validSecret 拒绝空白和控制字符，但从不把原值写入错误。
func validSecret(value string) bool {
	return value != "" &&
		value == strings.TrimSpace(value) &&
		!strings.ContainsAny(value, "\x00\r\n")
}
