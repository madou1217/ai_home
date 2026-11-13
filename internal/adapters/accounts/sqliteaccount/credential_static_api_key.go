package sqliteaccount

import (
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

type staticAPIKeyCredentialV1 struct {
	APIKey  string `json:"api_key"`
	BaseURL string `json:"base_url,omitempty"`
}

func encodeStaticAPIKeyCredential(
	providerID string,
	auth *accountcore.StaticAPIKeyAuth,
) (encodedCredential, error) {
	if auth == nil || auth.ProviderID() != providerID {
		return encodedCredential{}, ErrInvalidCredential
	}
	payload, err := encodeCredentialJSON(staticAPIKeyCredentialV1{
		APIKey:  auth.APIKey(),
		BaseURL: auth.BaseURL(),
	})
	if err != nil {
		return encodedCredential{}, err
	}
	return encodedCredential{
		authKind: accountcore.StaticAPIKeyAuthKind,
		authMode: accountcore.StaticAPIKeyAuthMode,
		json:     payload,
	}, nil
}

func decodeStaticAPIKeyCredential(
	providerID string,
	payload []byte,
) (accountapp.Credential, error) {
	var document staticAPIKeyCredentialV1
	if err := decodeCredentialJSON(payload, &document); err != nil {
		return nil, err
	}
	auth, err := accountcore.NewStaticAPIKeyAuth(accountcore.StaticAPIKeyInput{
		ProviderID: providerID,
		APIKey:     document.APIKey,
		BaseURL:    document.BaseURL,
	})
	if err != nil {
		return nil, ErrInvalidCredential
	}
	return auth, nil
}
