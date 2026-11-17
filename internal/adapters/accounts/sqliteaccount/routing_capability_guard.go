package sqliteaccount

import (
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

const (
	noGoUpstreamRoutingReason        = "no_go_upstream"
	customUpstreamRelayRoutingReason = "custom_upstream_relay"
	routingEndpointAuthorityRequired = "routing_endpoint_authority_required"
)

// Only these two values belonged to the retired Node-derived writer. Unknown
// and empty reasons remain manual intent, including AliasPoolParticipates=false.
func legacyDerivedRoutingReason(reason string) bool {
	return reason == noGoUpstreamRoutingReason || reason == customUpstreamRelayRoutingReason
}

func (store *Store) capabilityRoutingReason(provider string) (string, bool) {
	definition, ok := store.catalog.Get(provider)
	if !ok {
		return noGoUpstreamRoutingReason, false
	}
	host := definition.RelayHosts[providers.RelayHostGo]
	if !host.Supported {
		return noGoUpstreamRoutingReason, false
	}
	supported := len(host.Entries) == 0
	for _, entry := range host.Entries {
		if entry == "gateway.openai.chat_completions" || entry == "gateway.anthropic.messages" {
			supported = true
		}
	}
	if !supported || (host.Channel != providers.RelayChannelCanonical && host.Channel != providers.RelayChannelRelay) {
		return noGoUpstreamRoutingReason, false
	}
	return "", host.Channel == providers.RelayChannelRelay
}

// Endpoint absence on a typed static credential means the canonical default.
// A native API-key envelope has no typed endpoint facet: exclude that account
// explicitly rather than guessing from env or poisoning every Store's startup.
func (store *Store) derivedRoutingReason(provider string, credential accountapp.Credential) string {
	if credentialRoutingExcluded(credential) {
		return "vertex_placeholder"
	}
	reason, relayOnly := store.capabilityRoutingReason(provider)
	if reason != "" || !relayOnly {
		return reason
	}
	if credential == nil {
		return "credential_missing"
	}
	_, baseURL, static := staticCredentialUIStateMeta(credential)
	if !static {
		if native, ok := credential.(*accountcore.NativeCredential); ok {
			if native.AuthKind() == "oauth" {
				return ""
			}
		}
		return routingEndpointAuthorityRequired
	}
	if strings.TrimSpace(baseURL) == "" || len(providers.ListOfficialUpstreamHosts(provider)) == 0 {
		return ""
	}
	if !providers.IsOfficialUpstreamHost(provider, providers.ReadUpstreamHost(baseURL)) {
		return customUpstreamRelayRoutingReason
	}
	return ""
}
