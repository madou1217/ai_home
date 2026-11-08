package zcodeoauth

import (
	"crypto/subtle"
	"net/url"
	"strings"

	"github.com/madou1217/ai_home/application/accountauth"
)

const maxCallbackBytes = 16 * 1024

// parseCallback 从用户粘贴的内容里取出 code。
//
// 接受三种形态，与 Node 的 parseAuthorizationCodeInput + isSameCallbackEndpoint 一致：
//   - 完整回调地址：zcode://oauth/callback?code=…&state=…
//   - 只粘查询串（?code=… / code=…&state=…）：按 redirect 补齐 scheme/host/path；
//   - 只有 code：state 无从校验，按 state 不匹配拒绝（Node 同样拒绝）。
//
// endpoint、state、error 三个校验缺一不可：自定义协议没有 loopback 兜底，
// 粘错地址只能靠这里挡住。
func parseCallback(
	rawCallback string,
	expectedRedirect string,
	expectedState string,
) (string, error) {
	raw := strings.TrimSpace(rawCallback)
	if raw == "" || len(raw) > maxCallbackBytes {
		return "", accountauth.ErrInvalidCallback
	}
	expected, err := url.Parse(expectedRedirect)
	if err != nil || expected.Scheme == "" || expected.Host == "" {
		return "", accountauth.ErrInvalidCallback
	}
	callback, err := parseCallbackURL(raw, expected)
	if err != nil {
		return "", err
	}
	if callback.User != nil || !sameCallbackTarget(callback, expected) {
		return "", accountauth.ErrInvalidCallback
	}
	query, err := url.ParseQuery(callback.RawQuery)
	if err != nil {
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

// parseCallbackURL 把三种可粘贴形态归一成绝对 URL。
func parseCallbackURL(raw string, expected *url.URL) (*url.URL, error) {
	base := expected.Scheme + "://" + expected.Host + expected.Path
	switch {
	case strings.HasPrefix(raw, "?"):
		return url.Parse(base + raw)
	case strings.HasPrefix(raw, "/"):
		return url.Parse(expected.Scheme + "://" + expected.Host + raw)
	case hasScheme(raw):
		return url.Parse(raw)
	case looksLikeQuery(raw):
		return url.Parse(base + "?" + strings.TrimPrefix(raw, "?"))
	default:
		// 裸 code：没有 state 可比对，交给 state 校验拒绝。
		return url.Parse(base + "?code=" + url.QueryEscape(raw))
	}
}

// hasScheme 判断是否形如 scheme://…（自定义协议也必须走完整 URL 解析）。
func hasScheme(raw string) bool {
	index := strings.Index(raw, "://")
	if index <= 0 {
		return false
	}
	for position, character := range raw[:index] {
		switch {
		case character >= 'a' && character <= 'z',
			character >= 'A' && character <= 'Z':
		case position > 0 && (character >= '0' && character <= '9' ||
			character == '+' || character == '-' || character == '.'):
		default:
			return false
		}
	}
	return true
}

// looksLikeQuery 判断是否是裸查询串。
func looksLikeQuery(raw string) bool {
	return strings.HasPrefix(raw, "code=") ||
		strings.Contains(raw, "?code=") ||
		strings.Contains(raw, "&code=")
}

// sameCallbackTarget 比较 scheme、host 和 path，不接受重定向到其他目标。
func sameCallbackTarget(callback *url.URL, expected *url.URL) bool {
	return strings.EqualFold(callback.Scheme, expected.Scheme) &&
		strings.EqualFold(callback.Host, expected.Host) &&
		callback.Path == expected.Path
}

// singleValue 读取唯一且非空的字段，重复键一律拒绝。
func singleValue(query url.Values, key string) (string, bool) {
	return firstValue(query, key, false)
}

// singleOptionalValue 读取可缺失但不能重复的字段。
func singleOptionalValue(query url.Values, key string) (string, bool) {
	return firstValue(query, key, true)
}

// firstValue 实现必填与可选字段共享的唯一值校验。
func firstValue(query url.Values, key string, optional bool) (string, bool) {
	values, found := query[key]
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
