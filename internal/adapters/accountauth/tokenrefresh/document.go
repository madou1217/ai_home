package tokenrefresh

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"
)

// MaxDocumentBytes 约束原生凭据文档与上游成功响应的读取上界。
//
// 原生凭据本身已被 core/accounts 限制在 256KiB 内，这里用同一上界同时约束
// 刷新响应：任何更大的成功响应都不是三家 OAuth 端点会产出的形状。
const MaxDocumentBytes = 256 * 1024

// errInvalidDocument 表示原生凭据文档不是 JSON 对象。
var errInvalidDocument = errors.New("OAuth 原生凭据文档无效")

// DecodeDocument 有界解析原生凭据文档（必须是 JSON 对象）。
func DecodeDocument(payload []byte) (map[string]any, error) {
	if len(payload) == 0 || len(payload) > MaxDocumentBytes {
		return nil, errInvalidDocument
	}
	var document map[string]any
	if err := json.Unmarshal(payload, &document); err != nil || document == nil {
		return nil, errInvalidDocument
	}
	return document, nil
}

// Object 读取对象字段；非对象返回 nil。
func Object(value any) map[string]any {
	object, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return object
}

// CloneObject 复制一层对象，供「只替换令牌字段」的合并使用。
func CloneObject(source map[string]any) map[string]any {
	cloned := make(map[string]any, len(source)+4)
	for key, value := range source {
		cloned[key] = value
	}
	return cloned
}

// Text 依次读取第一个非空字符串字段（自动去空白）。
func Text(record map[string]any, keys ...string) string {
	for _, key := range keys {
		value, ok := record[key].(string)
		if !ok {
			continue
		}
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// Secret 读取可直接用于出网的令牌值；空白包裹或含换行的值一律视为缺失。
//
// 换行会把请求头或表单拆成两段，是注入而不是令牌；宁可判成缺失，也不能把它
// 原样带进 Authorization 或请求体。
func Secret(record map[string]any, keys ...string) string {
	for _, key := range keys {
		value, ok := record[key].(string)
		if !ok {
			continue
		}
		if ValidSecret(value) {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

// ValidSecret 判断令牌值是否是单行、非空且长度有界的字符串。
func ValidSecret(value string) bool {
	return value != "" &&
		len(value) <= MaxDocumentBytes &&
		value == strings.TrimSpace(value) &&
		!strings.ContainsAny(value, "\r\n\x00")
}

// TimestampMS 把多家混用的时间表示归一成 time.Time。
//
// 历史上同一字段混用过毫秒、秒与 RFC3339 字符串（Cline 的 expiresAt 落盘是毫秒
// 数字，刷新响应是 ISO；grok 的 expires_at 是 ISO）。按 1e12 阈值区分秒与毫秒，
// 避免把毫秒当秒读出几万年后的过期时间。
func TimestampMS(value any) (time.Time, bool) {
	switch typed := value.(type) {
	case json.Number:
		if parsed, err := typed.Float64(); err == nil {
			return epochMillis(parsed)
		}
	case float64:
		return epochMillis(typed)
	case int64:
		return epochMillis(float64(typed))
	case int:
		return epochMillis(float64(typed))
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return time.Time{}, false
		}
		if parsed, err := strconv.ParseFloat(trimmed, 64); err == nil {
			return epochMillis(parsed)
		}
		if parsed, err := time.Parse(time.RFC3339, trimmed); err == nil {
			return validTime(parsed)
		}
		if parsed, err := time.Parse(time.RFC3339Nano, trimmed); err == nil {
			return validTime(parsed)
		}
	}
	return time.Time{}, false
}

func epochMillis(value float64) (time.Time, bool) {
	if math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 {
		return time.Time{}, false
	}
	if value < 1e12 {
		value *= 1000
	}
	if value > 253_402_300_799_000 {
		return time.Time{}, false
	}
	return time.UnixMilli(int64(math.Round(value))).UTC(), true
}

func validTime(value time.Time) (time.Time, bool) {
	if value.IsZero() || value.UnixMilli() <= 0 || value.Year() > 9999 {
		return time.Time{}, false
	}
	return value.UTC(), true
}

// Integer 读取 JSON 数字或十进制字符串（Node 的 Number(candidate) 语义）。
func Integer(value any) int64 {
	switch typed := value.(type) {
	case json.Number:
		if result, err := typed.Int64(); err == nil && result > 0 {
			return result
		}
	case float64:
		if typed > 0 && typed <= 9_007_199_254_740_991 && math.Trunc(typed) == typed {
			return int64(typed)
		}
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err == nil && parsed > 0 && parsed <= 9_007_199_254_740_991 && math.Trunc(parsed) == parsed {
			return int64(parsed)
		}
	}
	return 0
}

// ISOString 输出与 Node toISOString 同形的毫秒精度 UTC 时间。
func ISOString(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

// JWTClaims 只解析 JWT 的未签名 payload。
//
// 签名无法在客户端验证，因此这些声明只用于过期判断与客户端元数据，绝不参与身份
// 判定（身份一律由 nativeaccount 从凭据文档重新派生）。
func JWTClaims(token string) map[string]any {
	if token == "" || len(token) > MaxDocumentBytes {
		return nil
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[1] == "" {
		return nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(decoded) == 0 {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(decoded))
	decoder.UseNumber()
	var claims map[string]any
	if decoder.Decode(&claims) != nil || claims == nil {
		return nil
	}
	return claims
}

// JWTExpiry 从 Access Token 的 exp 声明得到过期时间。
func JWTExpiry(token string) (time.Time, bool) {
	seconds := Integer(JWTClaims(token)["exp"])
	if seconds <= 0 || seconds >= 253_402_300_799 {
		return time.Time{}, false
	}
	return time.Unix(seconds, 0).UTC(), true
}

// JWTStringClaim 读取 JWT 的字符串声明（用于 client_id / aud 这类客户端元数据）。
func JWTStringClaim(token string, claim string) string {
	value, ok := JWTClaims(token)[claim].(string)
	if !ok {
		return ""
	}
	value = strings.TrimSpace(value)
	if !ValidSecret(value) {
		return ""
	}
	return value
}
