package aihserver

import (
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/opencoderelay"
)

// opencodeRelayTransportPolicy keeps OAuth/CLI-only OpenCode accounts on Node;
// Go only receives the native API-key shape it can send over HTTP safely.
type opencodeRelayTransportPolicy struct{}

func (opencodeRelayTransportPolicy) SupportsCredential(credential accountapp.Credential) bool {
	return opencoderelay.SupportsCredential(credential)
}
