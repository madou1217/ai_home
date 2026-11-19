package aihserver

import (
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/opencoderelay"
)

// opencodeRelayTransportPolicy keeps OAuth/CLI-only OpenCode accounts on Node;
// Go 只接收能通过 HTTP 安全发送的原生 API Key 形状。
type opencodeRelayTransportPolicy struct{}

func (opencodeRelayTransportPolicy) SupportsCredential(credential accountapp.Credential) bool {
	return opencoderelay.SupportsCredential(credential)
}
