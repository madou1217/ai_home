package sub2api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

var (
	// ErrInvalidDocument 表示 sub2api 文档或账号字段无法安全转换。
	ErrInvalidDocument = errors.New("sub2api 单账号文档无效")
	// ErrUnsupportedAccount 表示文档中的平台或认证类型超出当前 Codex、Claude 边界。
	ErrUnsupportedAccount = errors.New("sub2api 账号类型不受支持")
)

// importDocument 是当前 sub2api-data 单账号导入接受的顶层合同。
type importDocument struct {
	Type           string            `json:"type"`
	Version        int               `json:"version,omitempty"`
	ExportedAt     string            `json:"exported_at"`
	Proxies        []json.RawMessage `json:"proxies"`
	Accounts       []importAccount   `json:"accounts"`
	SkippedShadows int               `json:"skipped_shadows,omitempty"`
}

// importAccount 保留 sub2api 当前固定账号字段，Provider 凭据继续延迟到策略内解码。
type importAccount struct {
	Name               string          `json:"name"`
	Notes              *string         `json:"notes,omitempty"`
	Platform           string          `json:"platform"`
	Type               string          `json:"type"`
	Credentials        json.RawMessage `json:"credentials"`
	Extra              json.RawMessage `json:"extra,omitempty"`
	ProxyKey           *string         `json:"proxy_key,omitempty"`
	Concurrency        int             `json:"concurrency"`
	Priority           int             `json:"priority"`
	RateMultiplier     *float64        `json:"rate_multiplier,omitempty"`
	ExpiresAt          *int64          `json:"expires_at,omitempty"`
	AutoPauseOnExpired *bool           `json:"auto_pause_on_expired,omitempty"`
}

// accountKind 是外部 platform 与 type 组成的策略查找键。
type accountKind struct {
	platform string
	authType string
}

// decodeStrategy 把一个已校验账号转换为领域凭据和可选公开资料。
type decodeStrategy func(
	account importAccount,
	exportedAt time.Time,
) (accountapp.Credential, accountapp.PublicProfile, error)

// Decoder 通过封闭策略表解码当前 sub2api 单账号文档。
type Decoder struct {
	strategies map[accountKind]decodeStrategy
}

// NewDecoder 创建只支持 Codex、Claude 当前认证类型的无状态解码器。
func NewDecoder() *Decoder {
	return &Decoder{
		strategies: map[accountKind]decodeStrategy{
			{platform: codexPlatform, authType: oauthType}:       decodeCodexOAuth,
			{platform: codexPlatform, authType: apiKeyType}:      decodeCodexAPIKey,
			{platform: claudePlatform, authType: oauthType}:      decodeClaudeOAuth,
			{platform: claudePlatform, authType: setupTokenType}: decodeClaudeSetupToken,
			{platform: claudePlatform, authType: apiKeyType}:     decodeClaudeAPIKey,
		},
	}
}

// DecodeAccount 严格读取一个 sub2api 账号，不接受批量、代理或未知格式版本。
func (decoder *Decoder) DecodeAccount(
	documentJSON []byte,
) (accountapp.Credential, accountapp.PublicProfile, error) {
	if decoder == nil || len(decoder.strategies) == 0 {
		return nil, nil, invalidDocument("解码器未初始化")
	}
	var document importDocument
	if err := decodeStrictJSON(documentJSON, &document); err != nil {
		return nil, nil, invalidDocument("顶层 JSON 结构无效")
	}
	exportedAt, err := validateImportDocument(document)
	if err != nil {
		return nil, nil, err
	}
	account := document.Accounts[0]
	strategy, supported := decoder.strategies[accountKind{
		platform: account.Platform,
		authType: account.Type,
	}]
	if !supported {
		return nil, nil, ErrUnsupportedAccount
	}
	credential, profile, err := strategy(account, exportedAt)
	if err != nil {
		return nil, nil, err
	}
	if credential == nil {
		return nil, nil, invalidDocument("凭据转换结果为空")
	}
	return credential, profile, nil
}

// validateImportDocument 校验当前单账号边界并返回可信导出时间。
func validateImportDocument(document importDocument) (time.Time, error) {
	if document.Type != "" && document.Type != dataType {
		return time.Time{}, invalidDocument("数据类型不受支持")
	}
	if document.Version != 0 && document.Version != dataVersion {
		return time.Time{}, invalidDocument("数据版本不受支持")
	}
	exportedAt, err := time.Parse(time.RFC3339Nano, document.ExportedAt)
	if err != nil || exportedAt.IsZero() {
		return time.Time{}, invalidDocument("导出时间无效")
	}
	if document.Proxies == nil || len(document.Proxies) != 0 {
		return time.Time{}, invalidDocument("单账号导入不接受代理")
	}
	if len(document.Accounts) != 1 || document.SkippedShadows < 0 {
		return time.Time{}, invalidDocument("必须且只能包含一个账号")
	}
	account := document.Accounts[0]
	if strings.TrimSpace(account.Name) == "" ||
		account.Name != strings.TrimSpace(account.Name) ||
		account.Platform != strings.TrimSpace(account.Platform) ||
		account.Type != strings.TrimSpace(account.Type) ||
		!isJSONObject(account.Credentials) {
		return time.Time{}, invalidDocument("账号基础字段无效")
	}
	if account.ProxyKey != nil && strings.TrimSpace(*account.ProxyKey) != "" {
		return time.Time{}, invalidDocument("单账号导入不接受代理绑定")
	}
	return exportedAt.UTC(), nil
}

// decodeCodexOAuth 通过 ID Token 领域构造器恢复稳定 Codex 身份。
func decodeCodexOAuth(
	account importAccount,
	_ time.Time,
) (accountapp.Credential, accountapp.PublicProfile, error) {
	input, err := decodeCodexOAuthCredential(account.Credentials)
	if err != nil {
		return nil, nil, invalidDocument("Codex OAuth 凭据无效")
	}
	auth, err := codex.NewOAuthAuth(codex.OAuthInput{
		AccessToken:       input.AccessToken,
		RefreshToken:      input.RefreshToken,
		IDToken:           input.IDToken,
		RefreshedAtMS:     input.RefreshedAtMS,
		ExplicitAccountID: input.ChatGPTAccountID,
	})
	if err != nil {
		return nil, nil, invalidDocument("Codex OAuth 凭据无效")
	}
	if input.PlanType != "" && input.PlanType != auth.PlanType() {
		return nil, nil, invalidDocument("Codex OAuth plan_type 冲突")
	}
	if input.Email != "" && !strings.EqualFold(input.Email, auth.Email()) {
		return nil, nil, invalidDocument("Codex OAuth email 冲突")
	}
	profile, err := codex.NewAccountProfile(auth.Profile())
	if err != nil {
		return nil, nil, invalidDocument("Codex OAuth 公开资料无效")
	}
	return auth, profile, nil
}

// decodeCodexAPIKey 把 OpenAI API Key 映射到 Codex 静态凭据。
func decodeCodexAPIKey(
	account importAccount,
	_ time.Time,
) (accountapp.Credential, accountapp.PublicProfile, error) {
	input, err := decodeAPIKeyCredential(account.Credentials)
	if err != nil {
		return nil, nil, invalidDocument("Codex API Key 无效")
	}
	auth, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey:  input.APIKey,
		BaseURL: input.BaseURL,
	})
	if err != nil {
		return nil, nil, invalidDocument("Codex API Key 无效")
	}
	return auth, nil, nil
}

// decodeClaudeOAuth 只接受可刷新且包含稳定 account_uuid 的完整 OAuth。
func decodeClaudeOAuth(
	account importAccount,
	_ time.Time,
) (accountapp.Credential, accountapp.PublicProfile, error) {
	input, extra, err := decodeClaudeInputs(account)
	if err != nil {
		return nil, nil, err
	}
	if input.RefreshToken == "" || input.ExpiresAtMS <= 0 {
		return nil, nil, invalidDocument("Claude OAuth 缺少刷新字段")
	}
	scopes := input.Scopes
	if !containsScope(scopes, "user:profile") {
		return nil, nil, invalidDocument("Claude OAuth 类型与 scope 不一致")
	}
	return newClaudeRefreshable(input, extra, scopes)
}

// decodeClaudeSetupToken 区分 sub2api 可刷新 setup-token 与 access-only Token。
func decodeClaudeSetupToken(
	account importAccount,
	_ time.Time,
) (accountapp.Credential, accountapp.PublicProfile, error) {
	input, extra, err := decodeClaudeInputs(account)
	if err != nil {
		return nil, nil, err
	}
	if input.RefreshToken != "" || input.ExpiresAtMS != 0 {
		if input.RefreshToken == "" || input.ExpiresAtMS <= 0 {
			return nil, nil, invalidDocument("Claude setup-token 刷新字段不完整")
		}
		scopes := input.Scopes
		if containsScope(scopes, "user:profile") {
			return nil, nil, invalidDocument("Claude setup-token scope 无效")
		}
		return newClaudeRefreshable(input, extra, scopes)
	}
	if input.AccountUUID != "" ||
		extra.AccountUUID != "" ||
		input.OrgUUID != "" ||
		extra.OrgUUID != "" ||
		input.Email != "" ||
		extra.Email != "" ||
		input.RefreshTokenExpiresAtMS != 0 ||
		input.ClientID != "" ||
		input.SubscriptionType != "" ||
		extra.SubscriptionType != "" ||
		input.RateLimitTier != "" ||
		extra.RateLimitTier != "" {
		return nil, nil, invalidDocument("Claude access-only Token 携带无法绑定的 OAuth 身份")
	}
	if len(input.Scopes) > 0 &&
		(len(input.Scopes) != 1 || input.Scopes[0] != claude.InferenceScope) {
		return nil, nil, invalidDocument("Claude access-only Token scope 无效")
	}
	auth, err := claude.NewOAuthTokenAuth(claude.OAuthTokenInput{
		AccessToken: input.AccessToken,
		BaseURL:     input.BaseURL,
	})
	if err != nil {
		return nil, nil, invalidDocument("Claude access-only Token 无效")
	}
	return auth, nil, nil
}

// decodeClaudeAPIKey 把 Anthropic API Key 映射到 Claude 静态凭据。
func decodeClaudeAPIKey(
	account importAccount,
	_ time.Time,
) (accountapp.Credential, accountapp.PublicProfile, error) {
	input, err := decodeAPIKeyCredential(account.Credentials)
	if err != nil {
		return nil, nil, invalidDocument("Claude API Key 无效")
	}
	auth, err := claude.NewAPIKeyAuth(claude.APIKeyInput{
		APIKey:  input.APIKey,
		BaseURL: input.BaseURL,
	})
	if err != nil {
		return nil, nil, invalidDocument("Claude API Key 无效")
	}
	return auth, nil, nil
}

// decodeClaudeInputs 从开放凭据和 extra 对象提取固定字段。
func decodeClaudeInputs(
	account importAccount,
) (claudeOAuthInput, claudeExtraInput, error) {
	input, err := decodeClaudeOAuthCredential(account.Credentials)
	if err != nil {
		return claudeOAuthInput{}, claudeExtraInput{},
			invalidDocument("Claude OAuth 凭据无效")
	}
	var extra claudeExtraInput
	if len(account.Extra) > 0 && string(account.Extra) != "null" {
		extra, err = decodeClaudeExtra(account.Extra)
		if err != nil {
			return claudeOAuthInput{}, claudeExtraInput{},
				invalidDocument("Claude extra 无效")
		}
	}
	return input, extra, nil
}

// newClaudeRefreshable 合并重复身份字段后构造可刷新 OAuth 与可选公开资料。
func newClaudeRefreshable(
	input claudeOAuthInput,
	extra claudeExtraInput,
	scopes []string,
) (accountapp.Credential, accountapp.PublicProfile, error) {
	accountUUID, err := mergeIdentity(input.AccountUUID, extra.AccountUUID)
	if err != nil || accountUUID == "" {
		return nil, nil, invalidDocument("Claude OAuth 缺少稳定 account_uuid")
	}
	orgUUID, err := mergeIdentity(input.OrgUUID, extra.OrgUUID)
	if err != nil {
		return nil, nil, invalidDocument("Claude OAuth org_uuid 冲突")
	}
	email, err := mergeEmail(input.Email, extra.Email)
	if err != nil {
		return nil, nil, invalidDocument("Claude OAuth email_address 冲突")
	}
	organizationName, err := mergeExact(input.OrganizationName, extra.OrganizationName)
	if err != nil {
		return nil, nil, invalidDocument("Claude OAuth organization_name 冲突")
	}
	subscriptionType, err := mergeExact(input.SubscriptionType, extra.SubscriptionType)
	if err != nil {
		return nil, nil, invalidDocument("Claude OAuth subscription_type 冲突")
	}
	rateLimitTier, err := mergeExact(input.RateLimitTier, extra.RateLimitTier)
	if err != nil {
		return nil, nil, invalidDocument("Claude OAuth rate_limit_tier 冲突")
	}
	auth, err := claude.NewOAuthAuth(claude.OAuthInput{
		AccessToken:             input.AccessToken,
		RefreshToken:            input.RefreshToken,
		ExpiresAtMS:             input.ExpiresAtMS,
		RefreshTokenExpiresAtMS: input.RefreshTokenExpiresAtMS,
		ClientID:                input.ClientID,
		Scopes:                  scopes,
		Identity: claude.OAuthIdentity{
			AccountUUID: accountUUID,
		},
	})
	if err != nil {
		return nil, nil, invalidDocument("Claude OAuth 凭据无效")
	}
	if email == "" {
		return auth, nil, nil
	}
	oauthProfile, err := claude.NewOAuthProfile(claude.OAuthProfileInput{
		AccountUUID:      accountUUID,
		Email:            email,
		OrganizationUUID: orgUUID,
		OrganizationName: organizationName,
	})
	if err != nil {
		return nil, nil, invalidDocument("Claude OAuth 公开资料无效")
	}
	subscription, err := claude.NewSubscription(subscriptionType, rateLimitTier)
	if err != nil {
		return nil, nil, invalidDocument("Claude OAuth 订阅资料无效")
	}
	profile, err := claude.NewAccountProfile(oauthProfile, subscription)
	if err != nil {
		return nil, nil, invalidDocument("Claude OAuth 公开资料无效")
	}
	return auth, profile, nil
}

// decodeStrictJSON 拒绝顶层和账号固定合同中的未知字段及尾随 JSON。
func decodeStrictJSON(document []byte, target any) error {
	if len(document) == 0 || target == nil {
		return ErrInvalidDocument
	}
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return ErrInvalidDocument
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return ErrInvalidDocument
	}
	return nil
}

// decodeCredentialObject 严格把 JSON 对象投影到已确认的 Provider DTO。
func decodeCredentialObject(document json.RawMessage, target any) error {
	if !isJSONObject(document) || target == nil {
		return ErrInvalidDocument
	}
	if err := decodeStrictJSON(document, target); err != nil {
		return ErrInvalidDocument
	}
	return nil
}

// isJSONObject 拒绝 null、数组和标量凭据。
func isJSONObject(document []byte) bool {
	trimmed := bytes.TrimSpace(document)
	return len(trimmed) >= 2 &&
		trimmed[0] == '{' &&
		trimmed[len(trimmed)-1] == '}'
}

// mergeIdentity 合并 credentials 与 extra 中可重复出现的 UUID。
func mergeIdentity(primary string, secondary string) (string, error) {
	switch {
	case primary == "":
		return secondary, nil
	case secondary == "":
		return primary, nil
	case strings.EqualFold(primary, secondary):
		return primary, nil
	default:
		return "", ErrInvalidDocument
	}
}

// mergeEmail 合并 credentials 与 extra 中可重复出现的邮箱。
func mergeEmail(primary string, secondary string) (string, error) {
	switch {
	case primary == "":
		return secondary, nil
	case secondary == "":
		return primary, nil
	case strings.EqualFold(primary, secondary):
		return primary, nil
	default:
		return "", ErrInvalidDocument
	}
}

// mergeExact 合并两个可选官方文本字段，并拒绝不同值。
func mergeExact(primary string, secondary string) (string, error) {
	switch {
	case primary == "":
		return secondary, nil
	case secondary == "":
		return primary, nil
	case primary == secondary:
		return primary, nil
	default:
		return "", ErrInvalidDocument
	}
}

// containsScope 判断外部 scope 列表是否包含精确权限。
func containsScope(scopes []string, expected string) bool {
	for _, scope := range scopes {
		if scope == expected {
			return true
		}
	}
	return false
}

// invalidDocument 只附加代码内固定原因，不包含外部凭据值。
func invalidDocument(reason string) error {
	return fmt.Errorf("%w: %s", ErrInvalidDocument, reason)
}
