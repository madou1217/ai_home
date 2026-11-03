package accounts

import "errors"

const maxNativeCredentialBytes = 256 * 1024

// ErrInvalidNativeCredential is safe to expose without any artifact contents.
var ErrInvalidNativeCredential = errors.New("provider 原生凭据无效")

// NewNativeCredential freezes the adapter-validated identity and native JSON payload.
func NewNativeCredential(identity NativeIdentity, payload []byte, generations ...NativeGeneration) (*NativeCredential, error) {
	if !identity.IsValid() || !validNativePayload(payload) || !validNativeGenerations(generations) {
		return nil, ErrInvalidNativeCredential
	}
	return &NativeCredential{
		providerID:  identity.providerID,
		authKind:    identity.authKind,
		identity:    identity,
		payload:     append([]byte(nil), payload...),
		generations: append([]NativeGeneration(nil), generations...),
	}, nil
}

// NativeCredential 保存已经由 Provider 策略验证过的官方 CLI 凭据。
type NativeCredential struct {
	providerID  string
	authKind    string
	identity    NativeIdentity
	payload     []byte
	generations []NativeGeneration
}

func (credential *NativeCredential) ProviderID() string {
	if credential == nil {
		return ""
	}
	return credential.providerID
}

func (credential *NativeCredential) IdentitySeed() string {
	if credential == nil {
		return ""
	}
	return credential.identity.seed
}

func (credential *NativeCredential) AuthKind() string {
	if credential == nil {
		return ""
	}
	return credential.authKind
}

// SupportsNativeReauthentication is capability metadata, not a fake refresh token.
// Actual refresh remains owned by the official Provider. Import may replace a
// grant only when its independently derived generation is provably newer.
func (credential *NativeCredential) SupportsNativeReauthentication() bool {
	return credential != nil && credential.authKind == "oauth"
}

// Payload returns a defensive copy, so callers cannot mutate identity evidence in place.
func (credential *NativeCredential) Payload() []byte {
	if credential == nil {
		return nil
	}
	return append([]byte(nil), credential.payload...)
}

func (credential *NativeCredential) String() string {
	if credential == nil {
		return "NativeCredential<invalid>"
	}
	return "NativeCredential{provider:" + credential.providerID + ", kind:" + credential.authKind + ", redacted:true}"
}

func (credential *NativeCredential) GoString() string { return credential.String() }
