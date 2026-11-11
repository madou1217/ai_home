package aihserver

import (
	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/qoderrelay"
)

// qoderRelayTransportPolicy 判定 qoder 账号能否由透传通道承载。
//
// 只接受 qoder / qodercn 的原生凭据：qoder 的鉴权依赖 CLI 登录态的 wasm 签名，
// 静态 API Key 形态没有可用签名材料，必须交回 Canonical。
type qoderRelayTransportPolicy struct{}

var _ accountrouting.CredentialTransportPolicy = qoderRelayTransportPolicy{}

// SupportsCredential 实现 CredentialTransportPolicy。
//
// 必须是原生 **登录态**：Provider 的 RewriteRequest 需要把登录材料解密后交给 wasm
// 签名，PAT（AuthKind=api-key，同样是 *NativeCredential）没有这份材料，走到透传
// 只会得到「凭据形态不支持」。在征召阶段就排除，请求才会安静交回 Canonical / Node，
// 而不是先选中再报错。
func (qoderRelayTransportPolicy) SupportsCredential(credential accountapp.Credential) bool {
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil {
		return false
	}
	if native.AuthKind() != "oauth" {
		return false
	}
	providerID := native.ProviderID()
	return providerID == qoderrelay.QoderProviderID || providerID == qoderrelay.QoderCNProviderID
}
