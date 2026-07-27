package sqliteaccount

import (
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
)

// claudeCredentialCodec 编解码 Claude 的四种凭据形态。
type claudeCredentialCodec struct{}

// ProviderID 返回 Claude 规范 Provider ID。
func (claudeCredentialCodec) ProviderID() string {
	return claude.ProviderID
}

// Encode 把经过领域校验的 Claude 凭据编码为 v1 JSON。
func (claudeCredentialCodec) Encode(
	credential accountapp.Credential,
) (encodedCredential, error) {
	switch auth := credential.(type) {
	case *claude.OAuthAuth:
		return encodeClaudeRefreshableOAuth(auth)
	case *claude.OAuthTokenAuth:
		return encodeClaudeOAuthToken(auth)
	case *claude.APIKeyAuth:
		return encodeClaudeAPIKey(auth)
	case *claude.AuthTokenAuth:
		return encodeClaudeAuthToken(auth)
	default:
		return encodedCredential{}, ErrInvalidCredential
	}
}

// Decode 解析 v1 JSON 并通过 Claude 领域构造器重新校验。
func (claudeCredentialCodec) Decode(
	authKind string,
	authMode string,
	payload []byte,
) (accountapp.Credential, error) {
	switch authKind {
	case claude.AuthKindOAuth.String():
		return decodeClaudeOAuth(authMode, payload)
	case claude.AuthKindAPIKey.String():
		return decodeClaudeAPIKey(authMode, payload)
	case claude.AuthKindAuthToken.String():
		return decodeClaudeAuthToken(authMode, payload)
	default:
		return nil, ErrInvalidCredential
	}
}

// encodeClaudeRefreshableOAuth 编码可刷新的 Claude OAuth 凭据。
func encodeClaudeRefreshableOAuth(auth *claude.OAuthAuth) (encodedCredential, error) {
	payload, err := encodeCredentialJSON(claudeOAuthCredentialV1{
		AccessToken:             auth.AccessToken(),
		RefreshToken:            auth.RefreshToken(),
		ExpiresAtMS:             auth.ExpiresAtMS(),
		RefreshTokenExpiresAtMS: auth.RefreshTokenExpiresAtMS(),
		ClientID:                auth.ClientID(),
		Scopes:                  auth.Scopes(),
		AccountUUID:             auth.AccountUUID(),
	})
	return encodedCredential{
		authKind: claude.AuthKindOAuth.String(),
		authMode: claude.OAuthModeRefreshable.String(),
		json:     payload,
	}, err
}

// encodeClaudeOAuthToken 编码不可刷新的 Claude setup-token。
func encodeClaudeOAuthToken(auth *claude.OAuthTokenAuth) (encodedCredential, error) {
	payload, err := encodeCredentialJSON(claudeOAuthTokenCredentialV1{
		AccessToken: auth.AccessToken(),
		BaseURL:     auth.BaseURL(),
	})
	return encodedCredential{
		authKind: claude.AuthKindOAuth.String(),
		authMode: claude.OAuthModeAccessToken.String(),
		json:     payload,
	}, err
}

// encodeClaudeAPIKey 编码 Claude API Key。
func encodeClaudeAPIKey(auth *claude.APIKeyAuth) (encodedCredential, error) {
	payload, err := encodeCredentialJSON(claudeAPIKeyCredentialV1{
		APIKey:  auth.APIKey(),
		BaseURL: auth.BaseURL(),
	})
	return encodedCredential{
		authKind: claude.AuthKindAPIKey.String(),
		json:     payload,
	}, err
}

// encodeClaudeAuthToken 编码 Claude Authorization Bearer Token。
func encodeClaudeAuthToken(auth *claude.AuthTokenAuth) (encodedCredential, error) {
	payload, err := encodeCredentialJSON(claudeAuthTokenCredentialV1{
		AuthToken: auth.AuthToken(),
		BaseURL:   auth.BaseURL(),
	})
	return encodedCredential{
		authKind: claude.AuthKindAuthToken.String(),
		json:     payload,
	}, err
}

// decodeClaudeOAuth 按 OAuth mode 区分可刷新凭据与 setup-token。
func decodeClaudeOAuth(
	authMode string,
	payload []byte,
) (accountapp.Credential, error) {
	switch authMode {
	case claude.OAuthModeRefreshable.String():
		var document claudeOAuthCredentialV1
		if err := decodeCredentialJSON(payload, &document); err != nil {
			return nil, err
		}
		return claude.NewOAuthAuth(claude.OAuthInput{
			AccessToken:             document.AccessToken,
			RefreshToken:            document.RefreshToken,
			ExpiresAtMS:             document.ExpiresAtMS,
			RefreshTokenExpiresAtMS: document.RefreshTokenExpiresAtMS,
			ClientID:                document.ClientID,
			Scopes:                  document.Scopes,
			Identity: claude.OAuthIdentity{
				AccountUUID: document.AccountUUID,
			},
		})
	case claude.OAuthModeAccessToken.String():
		var document claudeOAuthTokenCredentialV1
		if err := decodeCredentialJSON(payload, &document); err != nil {
			return nil, err
		}
		return claude.NewOAuthTokenAuth(claude.OAuthTokenInput{
			AccessToken: document.AccessToken,
			BaseURL:     document.BaseURL,
		})
	default:
		return nil, ErrInvalidCredential
	}
}

// decodeClaudeAPIKey 解码 Claude API Key。
func decodeClaudeAPIKey(
	authMode string,
	payload []byte,
) (accountapp.Credential, error) {
	if authMode != "" {
		return nil, ErrInvalidCredential
	}
	var document claudeAPIKeyCredentialV1
	if err := decodeCredentialJSON(payload, &document); err != nil {
		return nil, err
	}
	return claude.NewAPIKeyAuth(claude.APIKeyInput{
		APIKey:  document.APIKey,
		BaseURL: document.BaseURL,
	})
}

// decodeClaudeAuthToken 解码 Claude Authorization Bearer Token。
func decodeClaudeAuthToken(
	authMode string,
	payload []byte,
) (accountapp.Credential, error) {
	if authMode != "" {
		return nil, ErrInvalidCredential
	}
	var document claudeAuthTokenCredentialV1
	if err := decodeCredentialJSON(payload, &document); err != nil {
		return nil, err
	}
	return claude.NewAuthTokenAuth(claude.AuthTokenInput{
		AuthToken: document.AuthToken,
		BaseURL:   document.BaseURL,
	})
}

// claudeOAuthCredentialV1 是可刷新 Claude OAuth JSON 的唯一 v1 结构。
type claudeOAuthCredentialV1 struct {
	AccessToken             string   `json:"access_token"`
	RefreshToken            string   `json:"refresh_token"`
	ExpiresAtMS             int64    `json:"expires_at_ms"`
	RefreshTokenExpiresAtMS int64    `json:"refresh_token_expires_at_ms"`
	ClientID                string   `json:"client_id"`
	Scopes                  []string `json:"scopes"`
	AccountUUID             string   `json:"account_uuid"`
}

// claudeOAuthTokenCredentialV1 是 Claude setup-token JSON 的唯一 v1 结构。
type claudeOAuthTokenCredentialV1 struct {
	AccessToken string `json:"access_token"`
	BaseURL     string `json:"base_url"`
}

// claudeAPIKeyCredentialV1 是 Claude API Key JSON 的唯一 v1 结构。
type claudeAPIKeyCredentialV1 struct {
	APIKey  string `json:"api_key"`
	BaseURL string `json:"base_url"`
}

// claudeAuthTokenCredentialV1 是 Claude Auth Token JSON 的唯一 v1 结构。
type claudeAuthTokenCredentialV1 struct {
	AuthToken string `json:"auth_token"`
	BaseURL   string `json:"base_url"`
}
