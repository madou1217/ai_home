package sqliteaccount

import (
	"encoding/json"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"reflect"
)

// nativeCredentialCodec 持久化已由 Provider adapter 验证的原生 artifact。
// providerID 固定在注册表项中，阻止 payload 借由自报 Provider 跨边界恢复。
type nativeCredentialCodec struct{ providerID string }

func (codec nativeCredentialCodec) ProviderID() string { return codec.providerID }

func (codec nativeCredentialCodec) Encode(credential accountapp.Credential) (encodedCredential, error) {
	auth, ok := credential.(*accountcore.NativeCredential)
	if !ok || auth == nil || auth.ProviderID() != codec.providerID {
		return encodedCredential{}, ErrInvalidCredential
	}
	// Validate both directions: a programmatic caller must not pair another
	// person's native payload with an independently constructed identity value.
	decoded, err := nativeaccount.NewDecoder().DecodeNativeAuth(codec.providerID, auth.Payload())
	restored, valid := decoded.(*accountcore.NativeCredential)
	if err != nil || !valid || restored.IdentitySeed() != auth.IdentitySeed() || restored.AuthKind() != auth.AuthKind() ||
		!reflect.DeepEqual(restored.Generations(), auth.Generations()) {
		return encodedCredential{}, ErrInvalidCredential
	}
	payload, err := encodeCredentialJSON(nativeCredentialV1{NativeAuth: auth.Payload()})
	return encodedCredential{authKind: auth.AuthKind(), authMode: "native_auth_json", json: payload}, err
}

func (codec nativeCredentialCodec) Decode(authKind, authMode string, payload []byte) (accountapp.Credential, error) {
	if authMode != "native_auth_json" {
		return nil, ErrInvalidCredential
	}
	var document nativeCredentialV1
	if err := decodeCredentialJSON(payload, &document); err != nil {
		return nil, err
	}
	credential, err := nativeaccount.NewDecoder().DecodeNativeAuth(codec.providerID, document.NativeAuth)
	if err != nil || credential == nil || credential.ProviderID() != codec.providerID {
		return nil, ErrInvalidCredential
	}
	if native, ok := credential.(*accountcore.NativeCredential); !ok || native.AuthKind() != authKind {
		return nil, ErrInvalidCredential
	}
	return credential, nil
}

type nativeCredentialV1 struct {
	NativeAuth json.RawMessage `json:"native_auth_json"`
}
