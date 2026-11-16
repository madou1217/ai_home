package chatruntime

import (
	"context"
	"net/http"
	"slices"

	"github.com/madou1217/ai_home/application/inferencecatalog"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
)

// NativeProtocolCatalogReader reads one published snapshot using the existing
// application DTO. Nonempty Routes entries retain actual collector priority for
// text generation. Present-but-empty means canonical rules match but cannot
// satisfy text; absent means no canonical route and permits only raw relay IDs.
//
// The reader must return an error when unavailable and must never assemble
// carriers, aliases and routes from independent current.Load calls. Health is
// independent current health, explicitly separate from the route snapshot.
type NativeProtocolCatalogReader interface {
	ReadProtocolModelView(context.Context, inference.ClientProtocolID) (inferencecatalog.ProtocolModelView, error)
}

func (r *NativeModelCatalogResolver) readGatewayModels(ctx context.Context, target NativeExecutionDescriptor) (nativeModelCatalogRead, error) {
	read := nativeModelCatalogRead{observation: NativeModelCatalogObservation{Source: "gateway_published"}}
	reader := r.GatewaySnapshot
	if reader == nil {
		// Compatibility is a type assertion, never a fallback to separate
		// published carrier, alias or health reads.
		reader, _ = r.GatewayModels.(NativeProtocolCatalogReader)
	}
	if reader == nil {
		return read, NewError("native_model_gateway_catalog_unavailable", http.StatusServiceUnavailable, map[string]any{"reason": "protocol_snapshot_reader_required"})
	}
	protocol := inference.ClientProtocolID(target.ClientProtocol)
	view, err := reader.ReadProtocolModelView(ctx, protocol)
	if err != nil {
		return read, nativeModelSourceError("native_model_gateway_catalog_unavailable", err)
	}
	if err := ctx.Err(); err != nil {
		return read, err
	}
	generation := view.AliasGeneration
	read.observation.AliasGeneration = &generation
	// AliasGeneration identifies alias compilation only, not the complete
	// model snapshot. Health is independently observed, never a snapshot token.
	read.observation.Health = &NativeModelCatalogHealthObservation{
		Scope: "independent_current",
		Ready: view.Health.Ready,
		Stale: view.Health.Stale,
	}

	type carrierKey struct{ provider, model string }
	carriers := map[carrierKey]bool{}
	rawRelayIDs := map[string]bool{}
	modelIDs := map[string]bool{}
	aliasIDs := map[string]bool{}
	for _, carrier := range view.Carriers {
		if err := ctx.Err(); err != nil {
			return read, err
		}
		provider, model := carrier.ProviderID(), carrier.ModelID().String()
		if !carrier.IsValid() || !r.Catalog.Contains(provider) {
			return read, NewError("native_model_gateway_catalog_invalid", http.StatusServiceUnavailable, nil)
		}
		carriers[carrierKey{provider, model}] = true
		modelIDs[model] = true
		if r.gatewayModelChannel(provider, protocol) == providers.RelayChannelRelay && r.supportsNativeText(provider, model) {
			rawRelayIDs[model] = true
		}
	}
	for _, alias := range view.Aliases {
		if err := ctx.Err(); err != nil {
			return read, err
		}
		if _, err := runtimecore.NewModelID(alias.Alias); err != nil {
			return read, NewError("native_model_gateway_catalog_invalid", http.StatusServiceUnavailable, nil)
		}
		if _, err := runtimecore.NewModelID(alias.Target); err != nil || !r.Catalog.Contains(alias.Provider) {
			return read, NewError("native_model_gateway_catalog_invalid", http.StatusServiceUnavailable, nil)
		}
		modelIDs[alias.Alias] = true
		aliasIDs[alias.Alias] = true
	}
	read.models = make([]string, 0, len(modelIDs))
	for id := range modelIDs {
		if err := ctx.Err(); err != nil {
			return read, err
		}
		routes, matched := view.Routes[id]
		if !matched {
			// Only the absence of canonical rules permits raw relay execution.
			// An alias without a route is never rescued by a same-named raw ID.
			if !aliasIDs[id] && rawRelayIDs[id] {
				read.models = append(read.models, id)
			}
			continue
		}
		if len(routes) == 0 {
			// Canonical rules matched but cannot satisfy text. Do not mask that
			// failure with a raw relay carrier or an alias target from elsewhere.
			continue
		}
		// The first actual route determines execution. If it is filtered out,
		// do not substitute a lower-priority alias, later route or raw carrier.
		first := routes[0]
		if !first.IsValid() {
			return read, NewError("native_model_gateway_catalog_invalid", http.StatusServiceUnavailable, nil)
		}
		provider, model := string(first.ProviderID()), first.EffectiveModel()
		if carriers[carrierKey{provider, model}] &&
			r.gatewayModelChannel(provider, protocol) == providers.RelayChannelCanonical &&
			r.supportsNativeText(provider, model) {
			read.models = append(read.models, id)
		}
	}
	return read, nil
}

func (r *NativeModelCatalogResolver) gatewayModelChannel(provider string, protocol inference.ClientProtocolID) string {
	definition, found := r.Catalog.Get(provider)
	if !found || !protocol.IsValid() {
		return ""
	}
	host, found := definition.RelayHosts[providers.RelayHostGo]
	if !found || !host.Supported {
		return ""
	}
	if host.Channel != providers.RelayChannelCanonical && host.Channel != providers.RelayChannelRelay {
		return ""
	}
	if len(host.Entries) != 0 && !slices.Contains(host.Entries, "gateway."+string(protocol)) {
		return ""
	}
	return host.Channel
}
