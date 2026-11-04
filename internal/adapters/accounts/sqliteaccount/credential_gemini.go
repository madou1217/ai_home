package sqliteaccount

import (
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/gemini"
)

// geminiCredentialCodec 同时承接 native OAuth envelope 与 Vertex 占位凭据。
type geminiCredentialCodec struct {
	native nativeCredentialCodec
}

func (codec geminiCredentialCodec) ProviderID() string { return gemini.ProviderID }

func (codec geminiCredentialCodec) Encode(credential accountapp.Credential) (encodedCredential, error) {
	if vertex, ok := credential.(*gemini.VertexAuth); ok {
		payload, err := encodeCredentialJSON(geminiVertexCredentialV1{
			ProjectID:   vertex.ProjectID(),
			Location:    vertex.Location(),
			APIKey:      vertex.APIKey(),
			BaseURL:     vertex.BaseURL(),
			Placeholder: vertex.Placeholder(),
		})
		return encodedCredential{authKind: gemini.AuthKindVertex, json: payload}, err
	}
	return codec.native.Encode(credential)
}

func (codec geminiCredentialCodec) Decode(authKind, authMode string, payload []byte) (accountapp.Credential, error) {
	if authKind == gemini.AuthKindVertex && authMode == "" {
		var document geminiVertexCredentialV1
		if err := decodeCredentialJSON(payload, &document); err != nil {
			return nil, err
		}
		return gemini.NewVertexAuth(gemini.VertexInput{
			ProjectID:   document.ProjectID,
			Location:    document.Location,
			APIKey:      document.APIKey,
			BaseURL:     document.BaseURL,
			Placeholder: document.Placeholder,
		})
	}
	return codec.native.Decode(authKind, authMode, payload)
}

// geminiVertexCredentialV1 是 Vertex 占位凭据的唯一持久化结构。
type geminiVertexCredentialV1 struct {
	ProjectID   string `json:"project_id"`
	Location    string `json:"location"`
	APIKey      string `json:"api_key"`
	BaseURL     string `json:"base_url"`
	Placeholder bool   `json:"placeholder"`
}
