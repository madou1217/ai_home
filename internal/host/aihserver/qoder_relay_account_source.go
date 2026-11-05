package aihserver

import (
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/accountrouting"
	"github.com/madou1217/ai_home/internal/transport/http/qoderrelay"
)

// qoderRelayTransportPolicy 判定 qoder 账号能否由透传通道承载。
//
// 只接受 qoder / qodercn 的原生凭据：qoder 的鉴权依赖 CLI 登录态的 wasm 签名，
// 静态 API Key 形态没有可用签名材料，必须交回 Canonical。
type qoderRelayTransportPolicy struct{}

var _ accountrouting.CredentialTransportPolicy = qoderRelayTransportPolicy{}

// SupportsCredential 实现 CredentialTransportPolicy。
func (qoderRelayTransportPolicy) SupportsCredential(credential accountapp.Credential) bool {
	if credential == nil {
		return false
	}
	providerID := credential.ProviderID()
	return providerID == qoderrelay.QoderProviderID || providerID == qoderrelay.QoderCNProviderID
}
