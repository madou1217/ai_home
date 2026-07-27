package claude

import (
	"errors"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	// InferenceScope 是持久 Claude.ai OAuth 凭据必须拥有的推理权限。
	InferenceScope = "user:inference"
	// maxUnixMillis 是四位年份时间能够表示的最大 Unix 毫秒。
	maxUnixMillis int64 = 253_402_300_799_999
	// maxMetadataLength 限制非敏感展示元数据，避免日志和内存被异常输入放大。
	maxMetadataLength = 256
)

var (
	errInvalidSecret        = errors.New("Claude 凭据无效")
	errInvalidExpiry        = errors.New("Claude OAuth 过期时间无效")
	errInvalidRefreshExpiry = errors.New("Claude OAuth Refresh Token 过期时间无效")
	errInvalidScopes        = errors.New("Claude OAuth scopes 无效")
	errMissingInference     = errors.New("Claude OAuth 缺少推理 scope")
	errInvalidAccountUUID   = errors.New("Claude OAuth 账号 UUID 无效")
	errInvalidEmail         = errors.New("Claude OAuth 邮箱无效")
	errInvalidOrgUUID       = errors.New("Claude OAuth 组织 UUID 无效")
	errInvalidMetadata      = errors.New("Claude OAuth 公开元数据无效")
	uuidPattern             = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
)

// requireSecret 校验明文凭据，但错误文本永远不包含输入值。
func requireSecret(raw string) (string, error) {
	if raw == "" || raw != strings.TrimSpace(raw) || !utf8.ValidString(raw) || hasControlCharacter(raw) {
		return "", errInvalidSecret
	}
	return raw, nil
}

// normalizeUUID 校验并统一官方 UUID 的大小写。
func normalizeUUID(raw string, required bool, invalid error) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" && !required {
		return "", nil
	}
	if raw != value || !uuidPattern.MatchString(value) {
		return "", invalid
	}
	return strings.ToLower(value), nil
}

// normalizeEmail 校验可选公开邮箱并统一为小写。
func normalizeEmail(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", nil
	}
	if raw != value || len(value) > maxMetadataLength || hasControlCharacter(value) || strings.Count(value, "@") != 1 {
		return "", errInvalidEmail
	}
	parts := strings.SplitN(value, "@", 2)
	if parts[0] == "" || parts[1] == "" || strings.ContainsAny(value, " \t\r\n") {
		return "", errInvalidEmail
	}
	return strings.ToLower(value), nil
}

// normalizeMetadata 校验可选的非敏感官方元数据。
func normalizeMetadata(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", nil
	}
	if raw != value || len(value) > maxMetadataLength || !utf8.ValidString(value) || hasControlCharacter(value) {
		return "", errInvalidMetadata
	}
	return value, nil
}

// validateScopes 创建不可变副本，并拒绝空值、重复值和缺失推理权限。
func validateScopes(input []string) ([]string, error) {
	if len(input) == 0 {
		return nil, errInvalidScopes
	}
	seen := make(map[string]struct{}, len(input))
	out := make([]string, 0, len(input))
	hasInference := false
	for _, raw := range input {
		if raw == "" || raw != strings.TrimSpace(raw) || len(raw) > maxMetadataLength || !utf8.ValidString(raw) || hasControlCharacter(raw) || strings.IndexFunc(raw, unicode.IsSpace) >= 0 {
			return nil, errInvalidScopes
		}
		if _, exists := seen[raw]; exists {
			return nil, errInvalidScopes
		}
		seen[raw] = struct{}{}
		out = append(out, raw)
		if raw == InferenceScope {
			hasInference = true
		}
	}
	if !hasInference {
		return nil, errMissingInference
	}
	return out, nil
}

// hasControlCharacter 检测可能造成日志或协议注入的控制字符。
func hasControlCharacter(value string) bool {
	return strings.IndexFunc(value, unicode.IsControl) >= 0
}
