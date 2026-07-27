// Package oauthaccount 从 Claude 全局配置提取 secure storage 之外的 OAuth 账号身份。
package oauthaccount

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/internal/adapters/claude/internal/jsonobject"
)

const (
	canonicalAccountKey = "oauthAccount"
	legacyAccountKey    = "oauth_account"
)

// accountFieldAliases 列出 AIH 不接受的非官方 snake_case 字段。
var accountFieldAliases = []string{
	"account_uuid",
	"email_address",
	"organization_uuid",
	"organization_name",
	"organization_role",
	"workspace_role",
	"display_name",
	"has_extra_usage_enabled",
	"billing_type",
	"account_created_at",
	"subscription_created_at",
}

// ErrInvalidOAuthAccount 表示 Claude 全局配置没有完整、稳定的 OAuth 身份。
var ErrInvalidOAuthAccount = errors.New("Claude oauthAccount 身份无效")

// Decode 从官方全局配置 JSON 中提取完整 Claude OAuth 公开账号资料。
func Decode(data []byte) (claude.OAuthProfile, error) {
	if !utf8.Valid(data) {
		return claude.OAuthProfile{}, invalidOAuthAccount("JSON 必须使用有效 UTF-8")
	}
	document, err := jsonobject.Decode(data)
	if err != nil {
		return claude.OAuthProfile{}, invalidOAuthAccount("JSON 结构错误")
	}
	if _, exists := document[legacyAccountKey]; exists {
		return claude.OAuthProfile{}, invalidOAuthAccount("不接受历史身份字段别名")
	}
	rawAccount, exists := document[canonicalAccountKey]
	if !exists || jsonobject.IsNull(rawAccount) {
		return claude.OAuthProfile{}, invalidOAuthAccount("oauthAccount 缺失")
	}
	account, err := jsonobject.Decode(rawAccount)
	if err != nil {
		return claude.OAuthProfile{}, invalidOAuthAccount("oauthAccount 结构错误")
	}
	if hasAccountFieldAlias(account) {
		return claude.OAuthProfile{}, invalidOAuthAccount("不接受身份字段别名")
	}
	accountUUID, err := requiredString(account["accountUuid"])
	if err != nil {
		return claude.OAuthProfile{}, invalidOAuthAccount("accountUuid 无效")
	}
	email, err := requiredString(account["emailAddress"])
	if err != nil {
		return claude.OAuthProfile{}, invalidOAuthAccount("emailAddress 无效")
	}
	organizationUUID, err := optionalString(account["organizationUuid"])
	if err != nil {
		return claude.OAuthProfile{}, invalidOAuthAccount("organizationUuid 无效")
	}
	organizationName, err := optionalString(account["organizationName"])
	if err != nil {
		return claude.OAuthProfile{}, invalidOAuthAccount("organizationName 无效")
	}
	organizationRole, err := optionalString(account["organizationRole"])
	if err != nil {
		return claude.OAuthProfile{}, invalidOAuthAccount("organizationRole 无效")
	}
	workspaceRole, err := optionalString(account["workspaceRole"])
	if err != nil {
		return claude.OAuthProfile{}, invalidOAuthAccount("workspaceRole 无效")
	}
	displayName, err := optionalString(account["displayName"])
	if err != nil {
		return claude.OAuthProfile{}, invalidOAuthAccount("displayName 无效")
	}
	extraUsageEnabled, err := optionalBool(account["hasExtraUsageEnabled"])
	if err != nil {
		return claude.OAuthProfile{}, invalidOAuthAccount("hasExtraUsageEnabled 无效")
	}
	billingType, err := optionalString(account["billingType"])
	if err != nil {
		return claude.OAuthProfile{}, invalidOAuthAccount("billingType 无效")
	}
	accountCreatedAtMS, err := optionalRFC3339Millis(account["accountCreatedAt"])
	if err != nil {
		return claude.OAuthProfile{}, invalidOAuthAccount("accountCreatedAt 无效")
	}
	subscriptionCreatedAtMS, err := optionalRFC3339Millis(account["subscriptionCreatedAt"])
	if err != nil {
		return claude.OAuthProfile{}, invalidOAuthAccount("subscriptionCreatedAt 无效")
	}
	profile, domainErr := claude.NewOAuthProfile(claude.OAuthProfileInput{
		AccountUUID:             accountUUID,
		Email:                   email,
		OrganizationUUID:        organizationUUID,
		OrganizationName:        organizationName,
		OrganizationRole:        organizationRole,
		WorkspaceRole:           workspaceRole,
		DisplayName:             displayName,
		HasExtraUsageEnabled:    extraUsageEnabled,
		BillingType:             billingType,
		AccountCreatedAtMS:      accountCreatedAtMS,
		SubscriptionCreatedAtMS: subscriptionCreatedAtMS,
	})
	if domainErr != nil {
		return claude.OAuthProfile{}, invalidOAuthAccount("公开资料不满足领域约束")
	}
	return profile, nil
}

// Encode 创建只包含 oauthAccount 的最小官方全局配置。
func Encode(profile claude.OAuthProfile) ([]byte, error) {
	return Upsert([]byte("{}"), profile)
}

// Upsert 写入 oauthAccount，并原样保留全局配置中的其他顶层数据和未来字段。
func Upsert(existing []byte, profile claude.OAuthProfile) ([]byte, error) {
	validated, err := validateProfile(profile)
	if err != nil {
		return nil, invalidOAuthAccount("公开资料对象无效")
	}
	if !utf8.Valid(existing) {
		return nil, invalidOAuthAccount("现有 JSON 必须使用有效 UTF-8")
	}
	document, err := jsonobject.Decode(existing)
	if err != nil {
		return nil, invalidOAuthAccount("现有全局配置结构错误")
	}
	if _, exists := document[legacyAccountKey]; exists {
		return nil, invalidOAuthAccount("现有全局配置含历史身份字段别名")
	}

	account := make(map[string]json.RawMessage)
	if rawAccount, exists := document[canonicalAccountKey]; exists && !jsonobject.IsNull(rawAccount) {
		account, err = jsonobject.Decode(rawAccount)
		if err != nil {
			return nil, invalidOAuthAccount("现有 oauthAccount 结构错误")
		}
		if hasAccountFieldAlias(account) {
			return nil, invalidOAuthAccount("现有 oauthAccount 含身份字段别名")
		}
	}
	setString(account, "accountUuid", validated.AccountUUID())
	setString(account, "emailAddress", validated.Email())
	setOptionalString(account, "organizationUuid", validated.OrganizationUUID())
	setOptionalString(account, "organizationName", validated.OrganizationName())
	setOptionalString(account, "organizationRole", validated.OrganizationRole())
	setOptionalString(account, "workspaceRole", validated.WorkspaceRole())
	setOptionalString(account, "displayName", validated.DisplayName())
	extraUsageEnabled, hasExtraUsageState := validated.ExtraUsageEnabled()
	setOptionalBool(account, "hasExtraUsageEnabled", extraUsageEnabled, hasExtraUsageState)
	setOptionalString(account, "billingType", validated.BillingType())
	setOptionalTime(account, "accountCreatedAt", validated.AccountCreatedAtMS())
	setOptionalTime(account, "subscriptionCreatedAt", validated.SubscriptionCreatedAtMS())

	encodedAccount, err := json.Marshal(account)
	if err != nil {
		return nil, invalidOAuthAccount("oauthAccount 编码失败")
	}
	document[canonicalAccountKey] = encodedAccount
	encoded, err := json.Marshal(document)
	if err != nil {
		return nil, invalidOAuthAccount("全局配置编码失败")
	}
	return encoded, nil
}

// hasAccountFieldAlias 判断 oauthAccount 是否含 AIH 历史字段别名。
func hasAccountFieldAlias(account map[string]json.RawMessage) bool {
	for _, alias := range accountFieldAliases {
		if _, exists := account[alias]; exists {
			return true
		}
	}
	return false
}

// requiredString 解析必填非空 JSON 字符串。
func requiredString(raw json.RawMessage) (string, error) {
	if len(raw) == 0 || jsonobject.IsNull(raw) {
		return "", errors.New("字符串缺失")
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil || value == "" {
		return "", errors.New("字符串无效")
	}
	return value, nil
}

// optionalString 解析可缺失或为 null 的官方公开字符串。
func optionalString(raw json.RawMessage) (string, error) {
	if len(raw) == 0 || jsonobject.IsNull(raw) {
		return "", nil
	}
	return requiredString(raw)
}

// optionalBool 解析可缺失或为 null 的三态布尔值。
func optionalBool(raw json.RawMessage) (*bool, error) {
	if len(raw) == 0 || jsonobject.IsNull(raw) {
		return nil, nil
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, errors.New("布尔值无效")
	}
	return &value, nil
}

// optionalRFC3339Millis 把可选官方 RFC3339 时间转换为 Unix 毫秒。
func optionalRFC3339Millis(raw json.RawMessage) (int64, error) {
	value, err := optionalString(raw)
	if err != nil || value == "" {
		return 0, err
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil || parsed.UnixMilli() <= 0 {
		return 0, errors.New("RFC3339 时间无效")
	}
	return parsed.UnixMilli(), nil
}

// validateProfile 通过领域构造器重新校验公开资料零值。
func validateProfile(profile claude.OAuthProfile) (claude.OAuthProfile, error) {
	var extraUsageEnabled *bool
	if value, known := profile.ExtraUsageEnabled(); known {
		extraUsageEnabled = &value
	}
	return claude.NewOAuthProfile(claude.OAuthProfileInput{
		AccountUUID:             profile.AccountUUID(),
		Email:                   profile.Email(),
		OrganizationUUID:        profile.OrganizationUUID(),
		OrganizationName:        profile.OrganizationName(),
		OrganizationRole:        profile.OrganizationRole(),
		WorkspaceRole:           profile.WorkspaceRole(),
		DisplayName:             profile.DisplayName(),
		HasExtraUsageEnabled:    extraUsageEnabled,
		BillingType:             profile.BillingType(),
		AccountCreatedAtMS:      profile.AccountCreatedAtMS(),
		SubscriptionCreatedAtMS: profile.SubscriptionCreatedAtMS(),
	})
}

// setString 把必填字符串写入 JSON 对象。
func setString(target map[string]json.RawMessage, key string, value string) {
	target[key] = mustMarshal(value)
}

// setOptionalString 写入非空字符串，空值时移除旧字段。
func setOptionalString(target map[string]json.RawMessage, key string, value string) {
	if value == "" {
		delete(target, key)
		return
	}
	setString(target, key, value)
}

// setOptionalBool 写入已知布尔值，未知时移除旧字段。
func setOptionalBool(
	target map[string]json.RawMessage,
	key string,
	value bool,
	known bool,
) {
	if !known {
		delete(target, key)
		return
	}
	target[key] = mustMarshal(value)
}

// setOptionalTime 写入规范 UTC RFC3339 时间，未知时移除旧字段。
func setOptionalTime(target map[string]json.RawMessage, key string, milliseconds int64) {
	if milliseconds == 0 {
		delete(target, key)
		return
	}
	setString(target, key, time.UnixMilli(milliseconds).UTC().Format(time.RFC3339Nano))
}

// mustMarshal 编码已通过领域校验的标量，理论上不会失败。
func mustMarshal(value any) json.RawMessage {
	encoded, _ := json.Marshal(value)
	return encoded
}

// invalidOAuthAccount 用固定原因包装错误，避免回显全局配置内容。
func invalidOAuthAccount(reason string) error {
	return fmt.Errorf("%w: %s", ErrInvalidOAuthAccount, strings.TrimSpace(reason))
}
