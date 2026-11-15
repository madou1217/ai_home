package inferencecatalog

import (
	"context"
	"errors"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/application/modelalias"
	"github.com/madou1217/ai_home/core/inference"
)

// ProtocolModelView uses one immutable publication for carriers, display aliases
// and ordered canonical routes. Routes includes an empty entry when canonical
// rules match but cannot satisfy text; absence means no canonical rule (relay).
// Health.Stale is an independent observation, not a route-generation marker.
type ProtocolModelView struct {
	Carriers        []accountapp.RoutableModel
	Aliases         []modelalias.DisplayModel
	Routes          map[string][]inferencegateway.Route
	AliasGeneration int64
	Health          CatalogStatus
}

func (catalog *AtomicCatalog) ReadProtocolModelView(ctx context.Context, protocol inference.ClientProtocolID) (ProtocolModelView, error) {
	var result ProtocolModelView
	if catalog == nil || ctx == nil || !protocol.IsValid() {
		return result, ErrRouteCatalogUnavailable
	}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	snapshot := catalog.current.Load()
	if snapshot == nil || !snapshot.isValid() {
		return result, ErrRouteCatalogUnavailable
	}
	result.Carriers = append([]accountapp.RoutableModel(nil), snapshot.carriers...)
	result.AliasGeneration = snapshot.aliases.Generation
	result.Health = catalog.Status()
	result.Routes = make(map[string][]inferencegateway.Route)
	result.Aliases = []modelalias.DisplayModel{}
	if snapshot.routes == nil {
		return result, nil
	}
	required, _ := inference.NewCapabilitySet(inference.CapabilityTextGeneration)
	names := make(map[string]bool, len(result.Carriers)+len(snapshot.aliases.DisplayModels))
	aliasNames := make(map[string]bool, len(snapshot.aliases.DisplayModels))
	for _, carrier := range result.Carriers {
		names[carrier.ModelID().String()] = true
	}
	// Display entries supply names, not final target authority. A more-specific
	// wildcard can legitimately resolve one of those names to a different target.
	for _, alias := range snapshot.aliases.DisplayModels {
		names[alias.Alias] = true
		aliasNames[alias.Alias] = true
	}
	for name := range names {
		if err := ctx.Err(); err != nil {
			return ProtocolModelView{}, err
		}
		plan, err := snapshot.routes.ResolveModel(ctx, protocol, name, required)
		switch {
		case err == nil:
			routes := plan.Candidates()
			result.Routes[name] = routes
			if aliasNames[name] {
				seen := map[string]bool{}
				for _, route := range routes {
					key := string(route.ProviderID()) + "\x00" + route.EffectiveModel()
					if seen[key] {
						continue
					}
					seen[key] = true
					result.Aliases = append(result.Aliases, modelalias.DisplayModel{Alias: name, Target: route.EffectiveModel(), Provider: string(route.ProviderID())})
				}
			}
		case errors.Is(err, inferencegateway.ErrUnsupportedRouteCapabilities):
			result.Routes[name] = nil
		case errors.Is(err, inferencegateway.ErrRouteNotFound):
		default:
			return ProtocolModelView{}, err
		}
	}
	return result, nil
}
