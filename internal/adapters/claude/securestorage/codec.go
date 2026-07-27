// Package securestorage 在 Claude Code secure storage JSON 与 Claude OAuth 领域值之间做严格转换。
//
// macOS Keychain 和非 macOS .credentials.json 保存相同 JSON；该 Adapter 只负责格式转换，
// 不负责读取 Keychain 或文件，也不会从 opaque Token 猜测账号身份。
package securestorage

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/internal/adapters/claude/internal/jsonobject"
)

const (
	canonicalOAuthKey = "claudeAiOauth"
	legacyOAuthKey    = "claude_ai_oauth"
)

// ErrInvalidCredentials 表示输入不是受支持的 Claude Code 官方 OAuth secure storage。
//
// 具体错误只包含代码内固定文本，绝不回显 Token 或不可信 JSON 值。
var ErrInvalidCredentials = errors.New("Claude secure storage 凭据无效")

// DecodeOptions 保存 secure storage 之外、创建 OAuth 领域值所需的上下文。
type DecodeOptions struct {
	// Identity 来自官方 oauthAccount 配置或可信 OAuth 登录响应。
	Identity claude.OAuthIdentity
}

// oauthOutput 是 Claude Code 2.1.207 持久化 OAuth 的精确字段形态。
type oauthOutput struct {
	AccessToken           string   `json:"accessToken"`
	RefreshToken          string   `json:"refreshToken"`
	ExpiresAt             int64    `json:"expiresAt"`
	RefreshTokenExpiresAt int64    `json:"refreshTokenExpiresAt,omitempty"`
	ClientID              string   `json:"clientId,omitempty"`
	Scopes                []string `json:"scopes"`
	SubscriptionType      *string  `json:"subscriptionType"`
	RateLimitTier         *string  `json:"rateLimitTier"`
}

// Decode 从 Keychain 或 .credentials.json 的原始 JSON 中提取官方 OAuth 凭据。
func Decode(data []byte, options DecodeOptions) (*claude.OAuthAuth, error) {
	if !utf8.Valid(data) {
		return nil, invalidCredentials("JSON 必须使用有效 UTF-8")
	}
	document, err := jsonobject.Decode(data)
	if err != nil {
		return nil, invalidCredentials("JSON 结构错误")
	}
	if _, exists := document[legacyOAuthKey]; exists {
		return nil, invalidCredentials("不接受历史 OAuth 字段别名")
	}
	rawOAuth, exists := document[canonicalOAuthKey]
	if !exists || jsonobject.IsNull(rawOAuth) {
		return nil, invalidCredentials("claudeAiOauth 缺失")
	}
	oauthFields, err := jsonobject.DecodeShape(
		rawOAuth,
		[]string{
			"accessToken",
			"refreshToken",
			"expiresAt",
			"scopes",
			"subscriptionType",
			"rateLimitTier",
		},
		"refreshTokenExpiresAt",
		"clientId",
	)
	if err != nil {
		return nil, invalidCredentials("claudeAiOauth 结构错误")
	}

	accessToken, err := decodeRequiredString(oauthFields["accessToken"])
	if err != nil {
		return nil, invalidCredentials("accessToken 无效")
	}
	refreshToken, err := decodeRequiredString(oauthFields["refreshToken"])
	if err != nil {
		return nil, invalidCredentials("refreshToken 无效")
	}
	expiresAt, err := decodeRequiredInt64(oauthFields["expiresAt"])
	if err != nil {
		return nil, invalidCredentials("expiresAt 无效")
	}
	refreshTokenExpiresAt, err := decodeOptionalPositiveInt64(oauthFields["refreshTokenExpiresAt"])
	if err != nil {
		return nil, invalidCredentials("refreshTokenExpiresAt 无效")
	}
	clientID, err := decodeOptionalMetadata(oauthFields["clientId"])
	if err != nil {
		return nil, invalidCredentials("clientId 无效")
	}
	scopes, err := decodeRequiredStrings(oauthFields["scopes"])
	if err != nil {
		return nil, invalidCredentials("scopes 无效")
	}
	subscriptionType, err := decodeNullableMetadata(oauthFields["subscriptionType"])
	if err != nil {
		return nil, invalidCredentials("subscriptionType 无效")
	}
	rateLimitTier, err := decodeNullableMetadata(oauthFields["rateLimitTier"])
	if err != nil {
		return nil, invalidCredentials("rateLimitTier 无效")
	}

	auth, domainErr := claude.NewOAuthAuth(claude.OAuthInput{
		AccessToken:             accessToken,
		RefreshToken:            refreshToken,
		ExpiresAtMS:             expiresAt,
		RefreshTokenExpiresAtMS: refreshTokenExpiresAt,
		ClientID:                clientID,
		Scopes:                  scopes,
		Identity:                options.Identity,
		SubscriptionType:        subscriptionType,
		RateLimitTier:           rateLimitTier,
	})
	if domainErr != nil {
		return nil, invalidCredentials("OAuth 凭据不满足领域约束")
	}
	return auth, nil
}

// Encode 创建只包含 claudeAiOauth 的最小官方 secure storage 文档。
func Encode(auth *claude.OAuthAuth) ([]byte, error) {
	return Upsert([]byte("{}"), auth)
}

// Upsert 写入 claudeAiOauth，同时原样保留 secure storage 的其他顶层数据。
func Upsert(existing []byte, auth *claude.OAuthAuth) ([]byte, error) {
	if auth == nil {
		return nil, invalidCredentials("认证对象为空")
	}
	validated, err := claude.NewOAuthAuth(claude.OAuthInput{
		AccessToken:             auth.AccessToken(),
		RefreshToken:            auth.RefreshToken(),
		ExpiresAtMS:             auth.ExpiresAtMS(),
		RefreshTokenExpiresAtMS: auth.RefreshTokenExpiresAtMS(),
		ClientID:                auth.ClientID(),
		Scopes:                  auth.Scopes(),
		Identity:                auth.Identity(),
		SubscriptionType:        auth.SubscriptionType(),
		RateLimitTier:           auth.RateLimitTier(),
	})
	if err != nil {
		return nil, invalidCredentials("OAuth 认证对象无效")
	}

	document, err := jsonobject.Decode(existing)
	if err != nil {
		return nil, invalidCredentials("现有 secure storage 结构错误")
	}
	if _, exists := document[legacyOAuthKey]; exists {
		return nil, invalidCredentials("现有 secure storage 含历史 OAuth 字段别名")
	}
	oauthJSON, err := encodeOAuth(validated)
	if err != nil {
		return nil, err
	}
	document[canonicalOAuthKey] = oauthJSON
	encoded, err := json.Marshal(document)
	if err != nil {
		return nil, invalidCredentials("secure storage 编码失败")
	}
	return encoded, nil
}

// encodeOAuth 把已验证的领域值写成官方 camelCase OAuth 对象。
func encodeOAuth(auth *claude.OAuthAuth) (json.RawMessage, error) {
	var subscriptionType *string
	if auth.SubscriptionType() != "" {
		value := auth.SubscriptionType()
		subscriptionType = &value
	}
	var rateLimitTier *string
	if auth.RateLimitTier() != "" {
		value := auth.RateLimitTier()
		rateLimitTier = &value
	}
	encoded, err := json.Marshal(oauthOutput{
		AccessToken:           auth.AccessToken(),
		RefreshToken:          auth.RefreshToken(),
		ExpiresAt:             auth.ExpiresAtMS(),
		RefreshTokenExpiresAt: auth.RefreshTokenExpiresAtMS(),
		ClientID:              auth.ClientID(),
		Scopes:                auth.Scopes(),
		SubscriptionType:      subscriptionType,
		RateLimitTier:         rateLimitTier,
	})
	if err != nil {
		return nil, invalidCredentials("OAuth 编码失败")
	}
	return encoded, nil
}

// decodeRequiredString 解析非空 JSON 字符串。
func decodeRequiredString(raw json.RawMessage) (string, error) {
	if len(raw) == 0 || jsonobject.IsNull(raw) {
		return "", errors.New("字符串缺失")
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil || value == "" {
		return "", errors.New("字符串无效")
	}
	return value, nil
}

// decodeNullableMetadata 解析官方必填但允许为 null 的公开元数据槽位。
func decodeNullableMetadata(raw json.RawMessage) (string, error) {
	if len(raw) == 0 {
		return "", errors.New("元数据字段缺失")
	}
	if jsonobject.IsNull(raw) {
		return "", nil
	}
	return decodeRequiredString(raw)
}

// decodeOptionalMetadata 解析可缺失或为 null 的官方字符串元数据。
func decodeOptionalMetadata(raw json.RawMessage) (string, error) {
	if len(raw) == 0 || jsonobject.IsNull(raw) {
		return "", nil
	}
	return decodeRequiredString(raw)
}

// decodeRequiredInt64 解析不允许浮点或指数歧义的十进制整数。
func decodeRequiredInt64(raw json.RawMessage) (int64, error) {
	if len(raw) == 0 || jsonobject.IsNull(raw) {
		return 0, errors.New("整数缺失")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value json.Number
	if err := decoder.Decode(&value); err != nil || jsonobject.EnsureEOF(decoder) != nil {
		return 0, errors.New("整数无效")
	}
	integer, err := value.Int64()
	if err != nil {
		return 0, errors.New("整数无效")
	}
	return integer, nil
}

// decodeOptionalPositiveInt64 解析可缺失或为 null、存在时必须为正数的官方整数元数据。
func decodeOptionalPositiveInt64(raw json.RawMessage) (int64, error) {
	if len(raw) == 0 || jsonobject.IsNull(raw) {
		return 0, nil
	}
	value, err := decodeRequiredInt64(raw)
	if err != nil || value <= 0 {
		return 0, errors.New("正整数无效")
	}
	return value, nil
}

// decodeRequiredStrings 解析非空字符串数组，具体 scope 不变量由领域层统一校验。
func decodeRequiredStrings(raw json.RawMessage) ([]string, error) {
	if len(raw) == 0 || jsonobject.IsNull(raw) {
		return nil, errors.New("字符串数组缺失")
	}
	var values []string
	if err := json.Unmarshal(raw, &values); err != nil || len(values) == 0 {
		return nil, errors.New("字符串数组无效")
	}
	return values, nil
}

// invalidCredentials 用固定原因包装稳定错误类型，不包含用户输入。
func invalidCredentials(reason string) error {
	return fmt.Errorf("%w: %s", ErrInvalidCredentials, strings.TrimSpace(reason))
}
