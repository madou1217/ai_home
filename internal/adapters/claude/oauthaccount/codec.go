// Package oauthaccount 从 Claude 全局配置提取 secure storage 之外的 OAuth 账号身份。
package oauthaccount

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/internal/adapters/claude/internal/jsonobject"
)

const (
	canonicalAccountKey = "oauthAccount"
	legacyAccountKey    = "oauth_account"
)

// ErrInvalidOAuthAccount 表示 Claude 全局配置没有完整、稳定的 OAuth 身份。
var ErrInvalidOAuthAccount = errors.New("Claude oauthAccount 身份无效")

// Decode 从官方全局配置 JSON 中提取账号 UUID、邮箱和可选组织 UUID。
func Decode(data []byte) (claude.OAuthIdentity, error) {
	if !utf8.Valid(data) {
		return claude.OAuthIdentity{}, invalidOAuthAccount("JSON 必须使用有效 UTF-8")
	}
	document, err := jsonobject.Decode(data)
	if err != nil {
		return claude.OAuthIdentity{}, invalidOAuthAccount("JSON 结构错误")
	}
	if _, exists := document[legacyAccountKey]; exists {
		return claude.OAuthIdentity{}, invalidOAuthAccount("不接受历史身份字段别名")
	}
	rawAccount, exists := document[canonicalAccountKey]
	if !exists || jsonobject.IsNull(rawAccount) {
		return claude.OAuthIdentity{}, invalidOAuthAccount("oauthAccount 缺失")
	}
	account, err := jsonobject.Decode(rawAccount)
	if err != nil {
		return claude.OAuthIdentity{}, invalidOAuthAccount("oauthAccount 结构错误")
	}
	for _, alias := range []string{"account_uuid", "email_address", "organization_uuid"} {
		if _, exists := account[alias]; exists {
			return claude.OAuthIdentity{}, invalidOAuthAccount("不接受身份字段别名")
		}
	}
	accountUUID, err := requiredString(account["accountUuid"])
	if err != nil {
		return claude.OAuthIdentity{}, invalidOAuthAccount("accountUuid 无效")
	}
	email, err := requiredString(account["emailAddress"])
	if err != nil {
		return claude.OAuthIdentity{}, invalidOAuthAccount("emailAddress 无效")
	}
	organizationUUID := ""
	if rawOrganization, exists := account["organizationUuid"]; exists {
		organizationUUID, err = requiredString(rawOrganization)
		if err != nil {
			return claude.OAuthIdentity{}, invalidOAuthAccount("organizationUuid 无效")
		}
	}
	identity, domainErr := claude.ValidateOAuthIdentity(claude.OAuthIdentity{
		AccountUUID:      accountUUID,
		Email:            email,
		OrganizationUUID: organizationUUID,
	})
	if domainErr != nil {
		return claude.OAuthIdentity{}, invalidOAuthAccount("身份不满足领域约束")
	}
	return identity, nil
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

// invalidOAuthAccount 用固定原因包装错误，避免回显全局配置内容。
func invalidOAuthAccount(reason string) error {
	return fmt.Errorf("%w: %s", ErrInvalidOAuthAccount, strings.TrimSpace(reason))
}
