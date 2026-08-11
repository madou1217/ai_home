package sub2api

import (
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

const (
	codexPlatform  = "openai"
	claudePlatform = "anthropic"
	oauthType      = "oauth"
	setupTokenType = "setup-token"
	apiKeyType     = "apikey"
)

// codexStrategy 编码 Codex OAuth 与 API Key。
type codexStrategy struct{}

// encode 根据封闭的 Codex 领域凭据类型生成外部账号。
func (codexStrategy) encode(
	snapshot accountapp.ExportSnapshot,
) (accountDocument, error) {
	switch auth := snapshot.Credential().(type) {
	case *codex.OAuthAuth:
		return newAccountDocument(
			exportName(snapshot),
			codexPlatform,
			oauthType,
			codexOAuthCredentials{
				AccessToken:      auth.AccessToken(),
				RefreshToken:     auth.RefreshToken(),
				IDToken:          auth.IDToken(),
				ChatGPTAccountID: auth.UpstreamAccountID(),
				PlanType:         auth.PlanType(),
				Email:            auth.Email(),
			},
		), nil
	case *codex.APIKeyAuth:
		return newAccountDocument(
			exportName(snapshot),
			codexPlatform,
			apiKeyType,
			apiKeyCredentials{
				APIKey:  auth.APIKey(),
				BaseURL: auth.BaseURL(),
			},
		), nil
	default:
		return accountDocument{}, accountapp.ErrUnsupportedAccountExport
	}
}

// claudeStrategy 编码 Claude OAuth 与 API Key。
type claudeStrategy struct{}

// encode 保持两种 Claude OAuth 生命周期，不把 Auth Token 冒充为标准类型。
func (claudeStrategy) encode(
	snapshot accountapp.ExportSnapshot,
) (accountDocument, error) {
	switch auth := snapshot.Credential().(type) {
	case *claude.OAuthAuth:
		return encodeClaudeRefreshableOAuth(snapshot, auth), nil
	case *claude.OAuthTokenAuth:
		return newAccountDocument(
			exportName(snapshot),
			claudePlatform,
			setupTokenType,
			claudeOAuthCredentials{
				AccessToken: auth.AccessToken(),
				BaseURL:     auth.BaseURL(),
				Scope:       strings.Join(auth.Scopes(), " "),
			},
		), nil
	case *claude.APIKeyAuth:
		return newAccountDocument(
			exportName(snapshot),
			claudePlatform,
			apiKeyType,
			apiKeyCredentials{
				APIKey:  auth.APIKey(),
				BaseURL: auth.BaseURL(),
			},
		), nil
	default:
		return accountDocument{}, accountapp.ErrUnsupportedAccountExport
	}
}

// encodeClaudeRefreshableOAuth 合并凭据与可选公开订阅资料。
func encodeClaudeRefreshableOAuth(
	snapshot accountapp.ExportSnapshot,
	auth *claude.OAuthAuth,
) accountDocument {
	credentials := claudeOAuthCredentials{
		AccessToken:           auth.AccessToken(),
		RefreshToken:          auth.RefreshToken(),
		ExpiresAt:             auth.ExpiresAtMS() / 1_000,
		RefreshTokenExpiresAt: auth.RefreshTokenExpiresAtMS() / 1_000,
		ClientID:              auth.ClientID(),
		Scope:                 strings.Join(auth.Scopes(), " "),
		AccountUUID:           auth.AccountUUID(),
	}
	extra := claudeAccountExtra{AccountUUID: auth.AccountUUID()}
	if profile, found := snapshot.Profile(); found {
		if claudeProfile, valid := profile.(claude.AccountProfile); valid {
			oauthProfile := claudeProfile.OAuthProfile()
			credentials.OrgUUID = oauthProfile.OrganizationUUID()
			credentials.Email = oauthProfile.Email()
			credentials.SubscriptionType = claudeProfile.SubscriptionRaw()
			credentials.RateLimitTier = claudeProfile.Subscription().RateLimitTier()
			extra.OrgUUID = oauthProfile.OrganizationUUID()
			extra.Email = oauthProfile.Email()
		}
	}
	accountType := oauthType
	if !auth.HasScope("user:profile") {
		accountType = setupTokenType
	}
	document := newAccountDocument(
		exportName(snapshot),
		claudePlatform,
		accountType,
		credentials,
	)
	document.Extra = extra
	return document
}

// newAccountDocument 固定当前业务尚未配置的并发和优先级默认值。
func newAccountDocument(
	name string,
	platform string,
	credentialType string,
	credentials any,
) accountDocument {
	return accountDocument{
		Name:        name,
		Platform:    platform,
		Type:        credentialType,
		Credentials: credentials,
		Concurrency: 0,
		Priority:    0,
	}
}

// exportName 沿用 provider-email 或 provider-baseURL 的标准命名规则。
func exportName(snapshot accountapp.ExportSnapshot) string {
	providerID := snapshot.Account().ProviderID()
	if profile, found := snapshot.Profile(); found && profile.Email() != "" {
		return providerID + "-" + profile.Email()
	}
	switch auth := snapshot.Credential().(type) {
	case *codex.OAuthAuth:
		if auth.Email() != "" {
			return providerID + "-" + auth.Email()
		}
	case *codex.APIKeyAuth:
		return providerID + "-" + auth.BaseURL()
	case *claude.APIKeyAuth:
		return providerID + "-" + auth.BaseURL()
	case *claude.OAuthTokenAuth:
		return providerID + "-" + auth.BaseURL()
	}
	return providerID + "-account"
}
