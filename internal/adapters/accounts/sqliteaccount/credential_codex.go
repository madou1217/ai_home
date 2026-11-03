package sqliteaccount

import (
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

// codexCredentialCodec 编解码 Codex OAuth 与 API Key 凭据。
type codexCredentialCodec struct{}

// ProviderID 返回 Codex 规范 Provider ID。
func (codexCredentialCodec) ProviderID() string {
	return codex.ProviderID
}

// Encode 把经过领域校验的 Codex 凭据编码为 v1 JSON。
func (codexCredentialCodec) Encode(
	credential accountapp.Credential,
) (encodedCredential, error) {
	switch auth := credential.(type) {
	case *codex.OAuthAuth:
		payload, err := encodeCredentialJSON(codexOAuthCredentialV1{
			AccessToken:       auth.AccessToken(),
			RefreshToken:      auth.RefreshToken(),
			IDToken:           auth.IDToken(),
			RefreshedAtMS:     auth.RefreshedAtMS(),
			ExplicitAccountID: auth.UpstreamAccountID(),
		})
		return encodedCredential{
			authKind: codex.AuthKindOAuth.String(),
			json:     payload,
		}, err
	case *codex.APIKeyAuth:
		payload, err := encodeCredentialJSON(codexAPIKeyCredentialV1{
			APIKey:  auth.APIKey(),
			BaseURL: auth.BaseURL(),
		})
		return encodedCredential{
			authKind: codex.AuthKindAPIKey.String(),
			json:     payload,
		}, err
	default:
		return encodedCredential{}, ErrInvalidCredential
	}
}

// Decode 解析 v1 JSON 并通过 Codex 领域构造器重新校验。
func (codexCredentialCodec) Decode(
	authKind string,
	authMode string,
	payload []byte,
) (accountapp.Credential, error) {
	if authMode != "" {
		return nil, ErrInvalidCredential
	}
	switch authKind {
	case codex.AuthKindOAuth.String():
		var document codexOAuthCredentialV1
		if err := decodeCredentialJSON(payload, &document); err != nil {
			return nil, err
		}
		return codex.NewOAuthAuth(codex.OAuthInput{
			AccessToken:       document.AccessToken,
			RefreshToken:      document.RefreshToken,
			IDToken:           document.IDToken,
			RefreshedAtMS:     document.RefreshedAtMS,
			ExplicitAccountID: document.ExplicitAccountID,
		})
	case codex.AuthKindAPIKey.String():
		var document codexAPIKeyCredentialV1
		if err := decodeCredentialJSON(payload, &document); err != nil {
			return nil, err
		}
		return codex.NewAPIKeyAuth(codex.APIKeyInput{
			APIKey:  document.APIKey,
			BaseURL: document.BaseURL,
		})
	default:
		return nil, ErrInvalidCredential
	}
}

// codexOAuthCredentialV1 是 Codex OAuth 凭据 JSON 的唯一 v1 结构。
type codexOAuthCredentialV1 struct {
	AccessToken       string `json:"access_token"`
	RefreshToken      string `json:"refresh_token"`
	IDToken           string `json:"id_token"`
	RefreshedAtMS     int64  `json:"refreshed_at_ms"`
	ExplicitAccountID string `json:"explicit_account_id"`
}

// codexAPIKeyCredentialV1 是 Codex API Key 凭据 JSON 的唯一 v1 结构。
type codexAPIKeyCredentialV1 struct {
	APIKey  string `json:"api_key"`
	BaseURL string `json:"base_url"`
}
