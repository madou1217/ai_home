package sqliteaccount

import (
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
)

// agyCredentialCodec 编解码 Antigravity consumer OAuth 凭据。
type agyCredentialCodec struct{}

func (agyCredentialCodec) ProviderID() string { return agy.ProviderID }

func (agyCredentialCodec) Encode(
	credential accountapp.Credential,
) (encodedCredential, error) {
	auth, valid := credential.(*agy.OAuthAuth)
	if !valid || auth == nil {
		return encodedCredential{}, ErrInvalidCredential
	}
	payload, err := encodeCredentialJSON(agyOAuthCredentialV1{
		Email:         auth.Email(),
		AccessToken:   auth.AccessToken(),
		RefreshToken:  auth.RefreshToken(),
		ExpiresAtMS:   auth.ExpiresAtMS(),
		RefreshedAtMS: auth.RefreshedAtMS(),
		TokenType:     auth.TokenType(),
		AuthMethod:    auth.AuthMethod().String(),
	})
	return encodedCredential{
		authKind: agy.AuthKindOAuth.String(),
		authMode: agy.AuthMethodConsumer.String(),
		json:     payload,
	}, err
}

func (agyCredentialCodec) Decode(
	authKind string,
	authMode string,
	payload []byte,
) (accountapp.Credential, error) {
	if authKind != agy.AuthKindOAuth.String() ||
		authMode != agy.AuthMethodConsumer.String() {
		return nil, ErrInvalidCredential
	}
	var document agyOAuthCredentialV1
	if err := decodeCredentialJSON(payload, &document); err != nil {
		return nil, err
	}
	credential, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         document.Email,
		AccessToken:   document.AccessToken,
		RefreshToken:  document.RefreshToken,
		ExpiresAtMS:   document.ExpiresAtMS,
		RefreshedAtMS: document.RefreshedAtMS,
		TokenType:     document.TokenType,
		AuthMethod:    agy.AuthMethod(document.AuthMethod),
	})
	if err != nil {
		return nil, ErrInvalidCredential
	}
	return credential, nil
}

type agyOAuthCredentialV1 struct {
	Email         string `json:"email"`
	AccessToken   string `json:"access_token"`
	RefreshToken  string `json:"refresh_token"`
	ExpiresAtMS   int64  `json:"expires_at_ms"`
	RefreshedAtMS int64  `json:"refreshed_at_ms"`
	TokenType     string `json:"token_type"`
	AuthMethod    string `json:"auth_method"`
}
