package aihserver

import (
	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/kirorelay"
)

// kiroRelayTransportPolicy 判定 kiro 账号能否由透传通道承载。
//
// 只接受原生登录态（access token + region + profileArn 都在 native_auth_json 里）；
// API Key / 仅 CLI 形态交还 Canonical。
type kiroRelayTransportPolicy struct{}

var _ accountrouting.CredentialTransportPolicy = kiroRelayTransportPolicy{}

// SupportsCredential 实现 CredentialTransportPolicy。
func (kiroRelayTransportPolicy) SupportsCredential(credential accountapp.Credential) bool {
	native, ok := credential.(*accountcore.NativeCredential)
	return ok && native != nil && native.ProviderID() == kirorelay.ProviderID
}
