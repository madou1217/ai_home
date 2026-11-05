package aihserver

import (
	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/zcoderelay"
)

// zcodeRelayTransportPolicy 判定 zcode 账号能否由透传通道承载。
//
// 只接受原生登录态（长期 jwt 与区域 access_token 都在 native_auth_json 里）；
// API Key / 仅 CLI 形态没有 harness 身份，交还 Canonical。
type zcodeRelayTransportPolicy struct{}

var _ accountrouting.CredentialTransportPolicy = zcodeRelayTransportPolicy{}

// SupportsCredential 实现 CredentialTransportPolicy。
func (zcodeRelayTransportPolicy) SupportsCredential(credential accountapp.Credential) bool {
	native, ok := credential.(*accountcore.NativeCredential)
	return ok && native != nil && native.ProviderID() == zcoderelay.ProviderID
}
