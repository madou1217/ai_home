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
	return encodedCredential{authKind: nativeStoredAuthKind(auth.AuthKind()), authMode: "native_auth_json", json: payload}, err
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
	if native, ok := credential.(*accountcore.NativeCredential); !ok || nativeStoredAuthKind(native.AuthKind()) != authKind {
		return nil, ErrInvalidCredential
	}
	return credential, nil
}

// nativeStoredAuthKind 把领域值映射到 account_credentials.auth_kind 的列约束
// （仅 [a-z0-9_]）：原生身份用 "api-key"，直接写入会触发 CHECK，被当成账号冲突，
// 导入端随后查不到账号而报 account_not_found。与 claude/codex 的 "api_key" 一致。
func nativeStoredAuthKind(authKind string) string {
	if authKind == "api-key" {
		return "api_key"
	}
	return authKind
}

type nativeCredentialV1 struct {
	NativeAuth json.RawMessage `json:"native_auth_json"`
}
