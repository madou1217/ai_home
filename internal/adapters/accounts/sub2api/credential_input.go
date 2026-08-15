package sub2api

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
	"time"
)

const (
	// maxUnixSeconds 与 maxUnixMillis 限定到 RFC3339 可表达的四位年份。
	maxUnixSeconds int64 = 253_402_300_799
	maxUnixMillis  int64 = 253_402_300_799_999
)

// codexOAuthInput 是进入 Codex 领域构造器的规范输入。
type codexOAuthInput struct {
	AccessToken      string
	RefreshToken     string
	IDToken          string
	RefreshedAtMS    int64
	ChatGPTAccountID string
	PlanType         string
	Email            string
}

// codexOAuthAliases 只声明 sub2api 与当前 AIH 标准导出的已确认同义字段。
type codexOAuthAliases struct {
	AccessTokenSnake      *string         `json:"access_token"`
	AccessTokenCamel      *string         `json:"accessToken"`
	RefreshTokenSnake     *string         `json:"refresh_token"`
	RefreshTokenCamel     *string         `json:"refreshToken"`
	IDTokenSnake          *string         `json:"id_token"`
	IDTokenCamel          *string         `json:"idToken"`
	LastRefreshSnake      json.RawMessage `json:"last_refresh"`
	LastRefreshCamel      json.RawMessage `json:"lastRefresh"`
	ChatGPTAccountIDSnake *string         `json:"chatgpt_account_id"`
	ChatGPTAccountIDCamel *string         `json:"chatgptAccountId"`
	PlanTypeSnake         *string         `json:"plan_type"`
	PlanTypeCamel         *string         `json:"planType"`
	Email                 *string         `json:"email"`
}

// apiKeyInput 是 Codex 与 Claude API Key 的规范输入。
type apiKeyInput struct {
	APIKey  string
	BaseURL string
}

// apiKeyAliases 收敛标准 snake_case 与现有 camelCase API Key 字段。
type apiKeyAliases struct {
	APIKeySnake  *string `json:"api_key"`
	APIKeyCamel  *string `json:"apiKey"`
	BaseURLSnake *string `json:"base_url"`
	BaseURLCamel *string `json:"baseUrl"`
}

// claudeOAuthInput 是进入 Claude 领域构造器的规范输入。
type claudeOAuthInput struct {
	AccessToken             string
	RefreshToken            string
	ExpiresAtMS             int64
	RefreshTokenExpiresAtMS int64
	ClientID                string
	Scopes                  []string
	AccountUUID             string
	OrgUUID                 string
	Email                   string
	OrganizationName        string
	SubscriptionType        string
	RateLimitTier           string
	BaseURL                 string
}

// claudeOAuthAliases 同时描述 sub2api snake_case 与 Claude 官方 secure storage camelCase。
type claudeOAuthAliases struct {
	AccessTokenSnake           *string               `json:"access_token"`
	AccessTokenCamel           *string               `json:"accessToken"`
	RefreshTokenSnake          *string               `json:"refresh_token"`
	RefreshTokenCamel          *string               `json:"refreshToken"`
	ExpiresAtSnake             json.RawMessage       `json:"expires_at"`
	ExpiresAtCamel             json.RawMessage       `json:"expiresAt"`
	Expiry                     json.RawMessage       `json:"expiry"`
	LastRefreshSnake           json.RawMessage       `json:"last_refresh"`
	LastRefreshCamel           json.RawMessage       `json:"lastRefresh"`
	RefreshTokenExpiresAtSnake json.RawMessage       `json:"refresh_token_expires_at"`
	RefreshTokenExpiresAtCamel json.RawMessage       `json:"refreshTokenExpiresAt"`
	ClientIDSnake              *string               `json:"client_id"`
	ClientIDCamel              *string               `json:"clientId"`
	Scope                      *string               `json:"scope"`
	Scopes                     *[]string             `json:"scopes"`
	AccountUUIDSnake           *string               `json:"account_uuid"`
	AccountUUIDCamel           *string               `json:"accountUuid"`
	OrgUUIDSnake               *string               `json:"org_uuid"`
	OrganizationUUIDSnake      *string               `json:"organization_uuid"`
	OrganizationUUIDCamel      *string               `json:"organizationUuid"`
	EmailAddressSnake          *string               `json:"email_address"`
	EmailAddressCamel          *string               `json:"emailAddress"`
	Email                      *string               `json:"email"`
	OrganizationNameSnake      *string               `json:"organization_name"`
	OrganizationNameCamel      *string               `json:"organizationName"`
	SubscriptionTypeSnake      *string               `json:"subscription_type"`
	SubscriptionTypeCamel      *string               `json:"subscriptionType"`
	RateLimitTierSnake         *string               `json:"rate_limit_tier"`
	RateLimitTierCamel         *string               `json:"rateLimitTier"`
	BaseURLSnake               *string               `json:"base_url"`
	BaseURLCamel               *string               `json:"baseUrl"`
	Account                    *claudeAccountAliases `json:"account"`
}

// claudeAccountAliases 描述 AIH Node 标准导出可能保留的 Claude 官方 account 对象。
type claudeAccountAliases struct {
	UUID                  *string `json:"uuid"`
	AccountUUIDSnake      *string `json:"account_uuid"`
	AccountUUIDCamel      *string `json:"accountUuid"`
	EmailAddressSnake     *string `json:"email_address"`
	EmailAddressCamel     *string `json:"emailAddress"`
	Email                 *string `json:"email"`
	OrgUUIDSnake          *string `json:"org_uuid"`
	OrganizationUUIDSnake *string `json:"organization_uuid"`
	OrganizationUUIDCamel *string `json:"organizationUuid"`
	OrganizationNameSnake *string `json:"organization_name"`
	OrganizationNameCamel *string `json:"organizationName"`
}

// claudeExtraInput 是 extra 中允许进入公开资料的规范字段。
type claudeExtraInput struct {
	AccountUUID      string
	OrgUUID          string
	Email            string
	OrganizationName string
	SubscriptionType string
	RateLimitTier    string
}

// claudeExtraAliases 拒绝 extra 中的本地身份、运行状态和任意未知 metadata。
type claudeExtraAliases struct {
	AccountUUIDSnake      *string `json:"account_uuid"`
	AccountUUIDCamel      *string `json:"accountUuid"`
	OrgUUIDSnake          *string `json:"org_uuid"`
	OrganizationUUIDSnake *string `json:"organization_uuid"`
	OrganizationUUIDCamel *string `json:"organizationUuid"`
	EmailAddressSnake     *string `json:"email_address"`
	EmailAddressCamel     *string `json:"emailAddress"`
	Email                 *string `json:"email"`
	OrganizationNameSnake *string `json:"organization_name"`
	OrganizationNameCamel *string `json:"organizationName"`
	SubscriptionTypeSnake *string `json:"subscription_type"`
	SubscriptionTypeCamel *string `json:"subscriptionType"`
	RateLimitTierSnake    *string `json:"rate_limit_tier"`
	RateLimitTierCamel    *string `json:"rateLimitTier"`
}

// decodeCodexOAuthCredential 严格读取 Codex OAuth 同义字段并检查冲突。
func decodeCodexOAuthCredential(document json.RawMessage) (codexOAuthInput, error) {
	var aliases codexOAuthAliases
	if err := decodeCredentialObject(document, &aliases); err != nil {
		return codexOAuthInput{}, err
	}
	accessToken, err := mergeStringAliases(false, aliases.AccessTokenSnake, aliases.AccessTokenCamel)
	if err != nil {
		return codexOAuthInput{}, err
	}
	refreshToken, err := mergeStringAliases(false, aliases.RefreshTokenSnake, aliases.RefreshTokenCamel)
	if err != nil {
		return codexOAuthInput{}, err
	}
	idToken, err := mergeStringAliases(false, aliases.IDTokenSnake, aliases.IDTokenCamel)
	if err != nil {
		return codexOAuthInput{}, err
	}
	refreshedAtMS, err := mergeTimestampAliases(
		aliases.LastRefreshSnake,
		aliases.LastRefreshCamel,
	)
	if err != nil {
		return codexOAuthInput{}, err
	}
	accountID, err := mergeStringAliases(false, aliases.ChatGPTAccountIDSnake, aliases.ChatGPTAccountIDCamel)
	if err != nil {
		return codexOAuthInput{}, err
	}
	planType, err := mergeStringAliases(false, aliases.PlanTypeSnake, aliases.PlanTypeCamel)
	if err != nil {
		return codexOAuthInput{}, err
	}
	return codexOAuthInput{
		AccessToken:      accessToken,
		RefreshToken:     refreshToken,
		IDToken:          idToken,
		RefreshedAtMS:    refreshedAtMS,
		ChatGPTAccountID: accountID,
		PlanType:         planType,
		Email:            valueOrEmpty(aliases.Email),
	}, nil
}

// decodeAPIKeyCredential 严格读取共享 API Key 同义字段并检查冲突。
func decodeAPIKeyCredential(document json.RawMessage) (apiKeyInput, error) {
	var aliases apiKeyAliases
	if err := decodeCredentialObject(document, &aliases); err != nil {
		return apiKeyInput{}, err
	}
	apiKey, err := mergeStringAliases(false, aliases.APIKeySnake, aliases.APIKeyCamel)
	if err != nil {
		return apiKeyInput{}, err
	}
	baseURL, err := mergeStringAliases(false, aliases.BaseURLSnake, aliases.BaseURLCamel)
	if err != nil {
		return apiKeyInput{}, err
	}
	return apiKeyInput{APIKey: apiKey, BaseURL: baseURL}, nil
}

// decodeClaudeOAuthCredential 严格归一化 Claude 标准字段和官方 artifact 字段。
func decodeClaudeOAuthCredential(document json.RawMessage) (claudeOAuthInput, error) {
	var aliases claudeOAuthAliases
	if err := decodeCredentialObject(document, &aliases); err != nil {
		return claudeOAuthInput{}, err
	}
	accessToken, err := mergeStringAliases(false, aliases.AccessTokenSnake, aliases.AccessTokenCamel)
	if err != nil {
		return claudeOAuthInput{}, err
	}
	refreshToken, err := mergeStringAliases(false, aliases.RefreshTokenSnake, aliases.RefreshTokenCamel)
	if err != nil {
		return claudeOAuthInput{}, err
	}
	expiresAtMS, err := mergeTimestampAliases(
		aliases.ExpiresAtSnake,
		aliases.ExpiresAtCamel,
		aliases.Expiry,
	)
	if err != nil {
		return claudeOAuthInput{}, err
	}
	if _, err = mergeTimestampAliases(aliases.LastRefreshSnake, aliases.LastRefreshCamel); err != nil {
		return claudeOAuthInput{}, err
	}
	refreshExpiresAtMS, err := mergeTimestampAliases(
		aliases.RefreshTokenExpiresAtSnake,
		aliases.RefreshTokenExpiresAtCamel,
	)
	if err != nil {
		return claudeOAuthInput{}, err
	}
	clientID, err := mergeStringAliases(false, aliases.ClientIDSnake, aliases.ClientIDCamel)
	if err != nil {
		return claudeOAuthInput{}, err
	}
	scopes, err := mergeScopeAliases(aliases.Scope, aliases.Scopes)
	if err != nil {
		return claudeOAuthInput{}, err
	}
	accountUUID, orgUUID, email, organizationName, err := decodeClaudeIdentityAliases(aliases)
	if err != nil {
		return claudeOAuthInput{}, err
	}
	subscriptionType, err := mergeStringAliases(
		false,
		aliases.SubscriptionTypeSnake,
		aliases.SubscriptionTypeCamel,
	)
	if err != nil {
		return claudeOAuthInput{}, err
	}
	rateLimitTier, err := mergeStringAliases(
		false,
		aliases.RateLimitTierSnake,
		aliases.RateLimitTierCamel,
	)
	if err != nil {
		return claudeOAuthInput{}, err
	}
	baseURL, err := mergeStringAliases(false, aliases.BaseURLSnake, aliases.BaseURLCamel)
	if err != nil {
		return claudeOAuthInput{}, err
	}
	return claudeOAuthInput{
		AccessToken:             accessToken,
		RefreshToken:            refreshToken,
		ExpiresAtMS:             expiresAtMS,
		RefreshTokenExpiresAtMS: refreshExpiresAtMS,
		ClientID:                clientID,
		Scopes:                  scopes,
		AccountUUID:             accountUUID,
		OrgUUID:                 orgUUID,
		Email:                   email,
		OrganizationName:        organizationName,
		SubscriptionType:        subscriptionType,
		RateLimitTier:           rateLimitTier,
		BaseURL:                 baseURL,
	}, nil
}

// decodeClaudeIdentityAliases 合并凭据顶层和官方 account 子对象中的公开身份。
func decodeClaudeIdentityAliases(
	aliases claudeOAuthAliases,
) (string, string, string, string, error) {
	account := aliases.Account
	var accountUUIDs, orgUUIDs, emails, organizationNames []*string
	if account != nil {
		accountUUIDs = []*string{account.UUID, account.AccountUUIDSnake, account.AccountUUIDCamel}
		orgUUIDs = []*string{account.OrgUUIDSnake, account.OrganizationUUIDSnake, account.OrganizationUUIDCamel}
		emails = []*string{account.EmailAddressSnake, account.EmailAddressCamel, account.Email}
		organizationNames = []*string{account.OrganizationNameSnake, account.OrganizationNameCamel}
	}
	accountUUID, err := mergeStringAliases(
		true,
		append([]*string{aliases.AccountUUIDSnake, aliases.AccountUUIDCamel}, accountUUIDs...)...,
	)
	if err != nil {
		return "", "", "", "", err
	}
	orgUUID, err := mergeStringAliases(
		true,
		append(
			[]*string{aliases.OrgUUIDSnake, aliases.OrganizationUUIDSnake, aliases.OrganizationUUIDCamel},
			orgUUIDs...,
		)...,
	)
	if err != nil {
		return "", "", "", "", err
	}
	email, err := mergeStringAliases(
		true,
		append([]*string{aliases.EmailAddressSnake, aliases.EmailAddressCamel, aliases.Email}, emails...)...,
	)
	if err != nil {
		return "", "", "", "", err
	}
	organizationName, err := mergeStringAliases(
		false,
		append(
			[]*string{aliases.OrganizationNameSnake, aliases.OrganizationNameCamel},
			organizationNames...,
		)...,
	)
	if err != nil {
		return "", "", "", "", err
	}
	return accountUUID, orgUUID, email, organizationName, nil
}

// decodeClaudeExtra 严格读取可迁移的 Claude 公开资料字段。
func decodeClaudeExtra(document json.RawMessage) (claudeExtraInput, error) {
	var aliases claudeExtraAliases
	if err := decodeCredentialObject(document, &aliases); err != nil {
		return claudeExtraInput{}, err
	}
	accountUUID, err := mergeStringAliases(true, aliases.AccountUUIDSnake, aliases.AccountUUIDCamel)
	if err != nil {
		return claudeExtraInput{}, err
	}
	orgUUID, err := mergeStringAliases(
		true,
		aliases.OrgUUIDSnake,
		aliases.OrganizationUUIDSnake,
		aliases.OrganizationUUIDCamel,
	)
	if err != nil {
		return claudeExtraInput{}, err
	}
	email, err := mergeStringAliases(
		true,
		aliases.EmailAddressSnake,
		aliases.EmailAddressCamel,
		aliases.Email,
	)
	if err != nil {
		return claudeExtraInput{}, err
	}
	organizationName, err := mergeStringAliases(
		false,
		aliases.OrganizationNameSnake,
		aliases.OrganizationNameCamel,
	)
	if err != nil {
		return claudeExtraInput{}, err
	}
	subscriptionType, err := mergeStringAliases(
		false,
		aliases.SubscriptionTypeSnake,
		aliases.SubscriptionTypeCamel,
	)
	if err != nil {
		return claudeExtraInput{}, err
	}
	rateLimitTier, err := mergeStringAliases(
		false,
		aliases.RateLimitTierSnake,
		aliases.RateLimitTierCamel,
	)
	if err != nil {
		return claudeExtraInput{}, err
	}
	return claudeExtraInput{
		AccountUUID:      accountUUID,
		OrgUUID:          orgUUID,
		Email:            email,
		OrganizationName: organizationName,
		SubscriptionType: subscriptionType,
		RateLimitTier:    rateLimitTier,
	}, nil
}

// mergeStringAliases 合并非空同义文本字段；大小写不敏感只用于 UUID 与邮箱。
func mergeStringAliases(caseInsensitive bool, values ...*string) (string, error) {
	selected := ""
	found := false
	for _, value := range values {
		if value == nil || *value == "" {
			continue
		}
		if !found {
			selected = *value
			found = true
			continue
		}
		equal := selected == *value
		if caseInsensitive {
			equal = strings.EqualFold(selected, *value)
		}
		if !equal {
			return "", ErrInvalidDocument
		}
	}
	return selected, nil
}

// mergeTimestampAliases 把秒、毫秒、数字字符串或 RFC3339 统一为 Unix 毫秒。
func mergeTimestampAliases(values ...json.RawMessage) (int64, error) {
	selected := int64(0)
	found := false
	for _, value := range values {
		if len(bytes.TrimSpace(value)) == 0 {
			continue
		}
		parsed, err := parseTimestampMillis(value)
		if err != nil {
			return 0, err
		}
		if !found {
			selected = parsed
			found = true
			continue
		}
		if selected != parsed {
			return 0, ErrInvalidDocument
		}
	}
	return selected, nil
}

// parseTimestampMillis 严格解析一个外部时间值并限制到四位年份。
func parseTimestampMillis(raw json.RawMessage) (int64, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return 0, ErrInvalidDocument
	}
	if err := requireJSONEOF(decoder); err != nil {
		return 0, err
	}
	var integer int64
	switch typed := value.(type) {
	case json.Number:
		parsed, err := strconv.ParseInt(string(typed), 10, 64)
		if err != nil {
			return 0, ErrInvalidDocument
		}
		integer = parsed
	case string:
		if typed == "" || typed != strings.TrimSpace(typed) {
			return 0, ErrInvalidDocument
		}
		if parsedTime, err := time.Parse(time.RFC3339Nano, typed); err == nil {
			milliseconds := parsedTime.UnixMilli()
			if milliseconds <= 0 || milliseconds > maxUnixMillis {
				return 0, ErrInvalidDocument
			}
			return milliseconds, nil
		}
		parsed, err := strconv.ParseInt(typed, 10, 64)
		if err != nil {
			return 0, ErrInvalidDocument
		}
		integer = parsed
	default:
		return 0, ErrInvalidDocument
	}
	if integer <= 0 {
		return 0, ErrInvalidDocument
	}
	if integer <= maxUnixSeconds {
		return integer * 1_000, nil
	}
	if integer <= maxUnixMillis {
		return integer, nil
	}
	return 0, ErrInvalidDocument
}

// mergeScopeAliases 把 scope 字符串与 scopes 数组统一为无重复权限列表。
func mergeScopeAliases(scope *string, scopes *[]string) ([]string, error) {
	var fromString []string
	if scope != nil {
		fromString = strings.Fields(*scope)
		if *scope != "" && len(fromString) == 0 {
			return nil, ErrInvalidDocument
		}
		if err := validateScopeList(fromString); err != nil {
			return nil, err
		}
	}
	var fromArray []string
	if scopes != nil {
		fromArray = append([]string(nil), (*scopes)...)
		if err := validateScopeList(fromArray); err != nil {
			return nil, err
		}
	}
	switch {
	case scope == nil && scopes == nil:
		return nil, nil
	case scope == nil:
		return fromArray, nil
	case scopes == nil:
		return fromString, nil
	case sameStringSet(fromString, fromArray):
		return fromString, nil
	default:
		return nil, ErrInvalidDocument
	}
}

// validateScopeList 拒绝空白、控制字符和重复 scope。
func validateScopeList(scopes []string) error {
	seen := make(map[string]struct{}, len(scopes))
	for _, scope := range scopes {
		if scope == "" || scope != strings.TrimSpace(scope) || strings.ContainsAny(scope, " \t\r\n") {
			return ErrInvalidDocument
		}
		if _, duplicated := seen[scope]; duplicated {
			return ErrInvalidDocument
		}
		seen[scope] = struct{}{}
	}
	return nil
}

// sameStringSet 比较 scope 集合，避免无意义顺序差异被误判为冲突。
func sameStringSet(left []string, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	values := make(map[string]struct{}, len(left))
	for _, value := range left {
		values[value] = struct{}{}
	}
	for _, value := range right {
		if _, found := values[value]; !found {
			return false
		}
	}
	return true
}

// requireJSONEOF 确保一个标量值后没有尾随 JSON。
func requireJSONEOF(decoder *json.Decoder) error {
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return ErrInvalidDocument
	}
	return nil
}

// valueOrEmpty 读取可选字符串，缺失时返回空值。
func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
