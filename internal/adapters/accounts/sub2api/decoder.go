package sub2api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
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

// DecodeAccount 严格读取一个 sub2api 账号，不接受批量、代理或格式版本。
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

// codexOAuthInput 是 sub2api 当前 OpenAI OAuth 凭据的必要字段。
type codexOAuthInput struct {
	AccessToken      string `json:"access_token"`
	RefreshToken     string `json:"refresh_token"`
	IDToken          string `json:"id_token"`
	ChatGPTAccountID string `json:"chatgpt_account_id,omitempty"`
}

// apiKeyInput 是 OpenAI 与 Anthropic API Key 的公共凭据字段。
type apiKeyInput struct {
	APIKey  string `json:"api_key"`
	BaseURL string `json:"base_url,omitempty"`
}

// claudeOAuthInput 是 sub2api 当前 Anthropic OAuth 与 setup-token 字段。
type claudeOAuthInput struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token,omitempty"`
	ExpiresAt    int64  `json:"expires_at,omitempty"`
	Scope        string `json:"scope,omitempty"`
	AccountUUID  string `json:"account_uuid,omitempty"`
	OrgUUID      string `json:"org_uuid,omitempty"`
	Email        string `json:"email_address,omitempty"`
	BaseURL      string `json:"base_url,omitempty"`
}

// claudeExtraInput 只从开放 extra 对象提取稳定公开身份，不向领域层传递任意 map。
type claudeExtraInput struct {
	AccountUUID string `json:"account_uuid,omitempty"`
	OrgUUID     string `json:"org_uuid,omitempty"`
	Email       string `json:"email_address,omitempty"`
}

// decodeCodexOAuth 通过 ID Token 领域构造器恢复稳定 Codex 身份。
func decodeCodexOAuth(
	account importAccount,
	exportedAt time.Time,
) (accountapp.Credential, accountapp.PublicProfile, error) {
	var input codexOAuthInput
	if err := decodeCredentialObject(account.Credentials, &input); err != nil {
		return nil, nil, invalidDocument("Codex OAuth 凭据无效")
	}
	auth, err := codex.NewOAuthAuth(codex.OAuthInput{
		AccessToken:       input.AccessToken,
		RefreshToken:      input.RefreshToken,
		IDToken:           input.IDToken,
		RefreshedAtMS:     exportedAt.UnixMilli(),
		ExplicitAccountID: input.ChatGPTAccountID,
	})
	if err != nil {
		return nil, nil, invalidDocument("Codex OAuth 凭据无效")
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
	var input apiKeyInput
	if err := decodeCredentialObject(account.Credentials, &input); err != nil {
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
	if input.RefreshToken == "" || input.ExpiresAt <= 0 {
		return nil, nil, invalidDocument("Claude OAuth 缺少刷新字段")
	}
	scopes := strings.Fields(input.Scope)
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
	if input.RefreshToken != "" || input.ExpiresAt != 0 {
		if input.RefreshToken == "" || input.ExpiresAt <= 0 {
			return nil, nil, invalidDocument("Claude setup-token 刷新字段不完整")
		}
		scopes := strings.Fields(input.Scope)
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
		extra.Email != "" {
		return nil, nil, invalidDocument("Claude access-only Token 携带无法绑定的 OAuth 身份")
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
	var input apiKeyInput
	if err := decodeCredentialObject(account.Credentials, &input); err != nil {
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
	var input claudeOAuthInput
	if err := decodeCredentialObject(account.Credentials, &input); err != nil {
		return claudeOAuthInput{}, claudeExtraInput{},
			invalidDocument("Claude OAuth 凭据无效")
	}
	var extra claudeExtraInput
	if len(account.Extra) > 0 && string(account.Extra) != "null" {
		if err := decodeCredentialObject(account.Extra, &extra); err != nil {
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
	expiresAtMS, err := unixSecondsToMillis(input.ExpiresAt)
	if err != nil {
		return nil, nil, invalidDocument("Claude OAuth expires_at 无效")
	}
	auth, err := claude.NewOAuthAuth(claude.OAuthInput{
		AccessToken:  input.AccessToken,
		RefreshToken: input.RefreshToken,
		ExpiresAtMS:  expiresAtMS,
		Scopes:       scopes,
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
	})
	if err != nil {
		return nil, nil, invalidDocument("Claude OAuth 公开资料无效")
	}
	subscription, err := claude.NewSubscription("", "")
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

// decodeCredentialObject 只把开放 JSON 对象投影到类型化 Provider DTO。
func decodeCredentialObject(document json.RawMessage, target any) error {
	if !isJSONObject(document) || target == nil {
		return ErrInvalidDocument
	}
	if err := json.Unmarshal(document, target); err != nil {
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

// containsScope 判断外部 scope 列表是否包含精确权限。
func containsScope(scopes []string, expected string) bool {
	for _, scope := range scopes {
		if scope == expected {
			return true
		}
	}
	return false
}

// unixSecondsToMillis 做有界换算，避免恶意整数溢出。
func unixSecondsToMillis(seconds int64) (int64, error) {
	if seconds <= 0 || seconds > math.MaxInt64/1_000 {
		return 0, ErrInvalidDocument
	}
	return seconds * 1_000, nil
}

// invalidDocument 只附加代码内固定原因，不包含外部凭据值。
func invalidDocument(reason string) error {
	return fmt.Errorf("%w: %s", ErrInvalidDocument, reason)
}
