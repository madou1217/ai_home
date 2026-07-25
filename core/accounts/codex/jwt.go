package codex

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strings"
	"unicode/utf8"
)

const codexAuthClaimNamespace = "https://api.openai.com/auth"
const codexProfileClaimNamespace = "https://api.openai.com/profile"

// Profile 是从 Codex ID Token 派生的公开账号资料值。
type Profile struct {
	// UserID 是稳定用户 ID，依次取 chatgpt_user_id、user_id 和标准 sub。
	UserID string
	// AccountID 是 ChatGPT 工作区 ID，缺失时固定为 personal。
	AccountID string
	// Email 是 ID Token 提供的展示邮箱。
	Email string
	// PlanType 是 ChatGPT 套餐类型。
	PlanType string
	// IsFedRAMP 表示工作区是否属于 FedRAMP 环境。
	IsFedRAMP bool
}

type codexIDTokenClaims struct {
	Subject string
	Email   string
	Auth    codexAuthClaims
	Profile codexProfileClaims
}

// codexAuthClaims 是 OpenAI 私有 auth 命名空间中当前需要的公开资料。
type codexAuthClaims struct {
	ChatGPTUserID    string
	UserID           string
	ChatGPTAccountID string
	ChatGPTPlanType  string
	AccountIsFedRAMP bool
}

// codexProfileClaims 是 OpenAI 私有 profile 命名空间中当前需要的公开资料。
type codexProfileClaims struct {
	Email string
}

// parseIDTokenProfile 解析 ID Token 中用于稳定身份和展示的公开 claim。
func parseIDTokenProfile(idToken string) (Profile, error) {
	payload, ok := decodeJWTPayload(idToken)
	if !ok {
		return Profile{}, errInvalidIDToken
	}
	claims, err := decodeCodexIDTokenClaims(payload)
	if err != nil {
		return Profile{}, errInvalidIDToken
	}

	userID := firstNonEmpty(claims.Auth.ChatGPTUserID, claims.Auth.UserID, claims.Subject)
	if !isIdentityComponent(userID) {
		return Profile{}, errMissingOAuthUserID
	}
	accountID := strings.TrimSpace(claims.Auth.ChatGPTAccountID)
	if accountID == PersonalAccountID || accountID != "" && !isIdentityComponent(accountID) {
		return Profile{}, errInvalidOAuthAccountID
	}
	if accountID == "" {
		accountID = PersonalAccountID
	}

	return Profile{
		UserID:    userID,
		AccountID: accountID,
		Email:     firstNonEmpty(claims.Email, claims.Profile.Email),
		PlanType:  strings.TrimSpace(claims.Auth.ChatGPTPlanType),
		IsFedRAMP: claims.Auth.AccountIsFedRAMP,
	}, nil
}

// readAccessTokenExpiryMS 尽力读取 Access Token 的 exp，无法解析时保持未知。
func readAccessTokenExpiryMS(accessToken string) int64 {
	payload, ok := decodeJWTPayload(accessToken)
	if !ok {
		return 0
	}
	expiresAtSeconds, ok := decodeJWTExpirySeconds(payload)
	if !ok {
		return 0
	}
	if expiresAtSeconds <= 0 || expiresAtSeconds > math.MaxInt64/1000 {
		return 0
	}
	return expiresAtSeconds * 1000
}

// decodeJWTPayload 只解码 JWT payload，不验证签名，结果绝不能作为授权证明。
func decodeJWTPayload(token string) ([]byte, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return nil, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	return payload, err == nil && utf8.Valid(payload)
}

// decodeCodexIDTokenClaims 按 JSON 精确键名解析已知 claim，同时允许官方增加未知 claim。
func decodeCodexIDTokenClaims(payload []byte) (codexIDTokenClaims, error) {
	var claims codexIDTokenClaims
	err := visitJSONObject(payload, func(name string, raw json.RawMessage) error {
		switch name {
		case "sub":
			value, err := decodeOptionalStringClaim(raw)
			claims.Subject = value
			return err
		case "email":
			value, err := decodeOptionalStringClaim(raw)
			claims.Email = value
			return err
		case codexAuthClaimNamespace:
			if isJSONNull(raw) {
				return nil
			}
			return decodeCodexAuthClaims(raw, &claims.Auth)
		case codexProfileClaimNamespace:
			if isJSONNull(raw) {
				return nil
			}
			return decodeCodexProfileClaims(raw, &claims.Profile)
		default:
			return nil
		}
	})
	if err != nil {
		return codexIDTokenClaims{}, err
	}
	return claims, nil
}

// decodeCodexAuthClaims 严格解析 OpenAI auth 命名空间中的已知字段类型。
func decodeCodexAuthClaims(raw []byte, claims *codexAuthClaims) error {
	return visitJSONObject(raw, func(name string, value json.RawMessage) error {
		switch name {
		case "chatgpt_user_id":
			decoded, err := decodeOptionalStringClaim(value)
			claims.ChatGPTUserID = decoded
			return err
		case "user_id":
			decoded, err := decodeOptionalStringClaim(value)
			claims.UserID = decoded
			return err
		case "chatgpt_account_id":
			decoded, err := decodeOptionalStringClaim(value)
			claims.ChatGPTAccountID = decoded
			return err
		case "chatgpt_plan_type":
			decoded, err := decodeOptionalStringClaim(value)
			claims.ChatGPTPlanType = decoded
			return err
		case "chatgpt_account_is_fedramp":
			decoded, err := decodeRequiredBoolClaim(value)
			claims.AccountIsFedRAMP = decoded
			return err
		default:
			return nil
		}
	})
}

// decodeCodexProfileClaims 严格解析 OpenAI profile 命名空间中的已知字段类型。
func decodeCodexProfileClaims(raw []byte, claims *codexProfileClaims) error {
	return visitJSONObject(raw, func(name string, value json.RawMessage) error {
		if name != "email" {
			return nil
		}
		decoded, err := decodeOptionalStringClaim(value)
		claims.Email = decoded
		return err
	})
}

// decodeJWTExpirySeconds 读取严格整数 exp；缺失或 null 表示过期时间未知。
func decodeJWTExpirySeconds(payload []byte) (int64, bool) {
	var expiresAt int64
	found := false
	err := visitJSONObject(payload, func(name string, raw json.RawMessage) error {
		if name != "exp" || isJSONNull(raw) {
			return nil
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		var decoded any
		if err := decoder.Decode(&decoded); err != nil {
			return errInvalidJWTClaims
		}
		number, ok := decoded.(json.Number)
		if !ok {
			return errInvalidJWTClaims
		}
		value, err := number.Int64()
		if err != nil {
			return errInvalidJWTClaims
		}
		expiresAt = value
		found = true
		return nil
	})
	return expiresAt, err == nil && found
}

var errInvalidJWTClaims = errors.New("JWT claim 结构无效")

// visitJSONObject 遍历单个 JSON 对象并拒绝重复键、尾随值和非对象输入。
func visitJSONObject(data []byte, visitor func(string, json.RawMessage) error) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return errInvalidJWTClaims
	}

	seen := make(map[string]struct{})
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return errInvalidJWTClaims
		}
		name, ok := token.(string)
		if !ok || strings.ContainsRune(name, utf8.RuneError) {
			return errInvalidJWTClaims
		}
		if _, duplicated := seen[name]; duplicated {
			return errInvalidJWTClaims
		}
		seen[name] = struct{}{}

		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return errInvalidJWTClaims
		}
		if err := visitor(name, raw); err != nil {
			return errInvalidJWTClaims
		}
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') {
		return errInvalidJWTClaims
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errInvalidJWTClaims
	}
	return nil
}

// decodeOptionalStringClaim 接受字符串或 null，并拒绝 Go JSON 的隐式类型宽松行为。
func decodeOptionalStringClaim(raw json.RawMessage) (string, error) {
	if isJSONNull(raw) {
		return "", nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", errInvalidJWTClaims
	}
	if strings.ContainsRune(value, utf8.RuneError) {
		return "", errInvalidJWTClaims
	}
	return value, nil
}

// decodeRequiredBoolClaim 只接受 JSON 布尔值，null 不会被静默转换成 false。
func decodeRequiredBoolClaim(raw json.RawMessage) (bool, error) {
	if isJSONNull(raw) {
		return false, errInvalidJWTClaims
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, errInvalidJWTClaims
	}
	return value, nil
}

// isJSONNull 判断原始 JSON 值是否为 null。
func isJSONNull(raw []byte) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// firstNonEmpty 返回第一个去除首尾空白后仍非空的文本。
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if normalized := strings.TrimSpace(value); normalized != "" {
			return normalized
		}
	}
	return ""
}

// isIdentityComponent 保证身份种子组件非空且不破坏冒号分隔格式。
func isIdentityComponent(value string) bool {
	normalized := strings.TrimSpace(value)
	return normalized != "" &&
		!strings.Contains(normalized, ":") &&
		!strings.ContainsRune(normalized, utf8.RuneError) &&
		!hasControlCharacter(normalized)
}
