package inferencecatalog

import (
	"context"

	"github.com/madou1217/ai_home/application/modelalias"
	"github.com/madou1217/ai_home/core/inference"
)

// ListDisplayModelsForProtocol narrows display aliases to their actual compiled
// routes for a client entry. Each item identifies a carrier that can execute it;
// an auto target must not imply support by relay providers without alias rules.
func (catalog *AtomicCatalog) ListDisplayModelsForProtocol(ctx context.Context, protocol inference.ClientProtocolID) ([]modelalias.DisplayModel, error) {
	if catalog == nil || ctx == nil || !protocol.IsValid() {
		return nil, ErrRouteCatalogUnavailable
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	snapshot := catalog.current.Load()
	if snapshot == nil || !snapshot.isValid() {
		return nil, ErrRouteCatalogUnavailable
	}
	out := []modelalias.DisplayModel{}
	seen := map[string]bool{}
	for _, alias := range snapshot.aliases.DisplayModels {
		for _, rule := range snapshot.aliases.Rules {
			route := rule.Route()
			if route.EffectiveModel() != alias.Target || (alias.Provider != "" && string(route.ProviderID()) != alias.Provider) {
				continue
			}
			resolved, err := snapshot.routes.ResolveProtocolRoute(ctx, protocol, alias.Alias, route.ProviderID(), route.ProtocolID())
			if err != nil || resolved.EffectiveModel() != alias.Target {
				continue
			}
			key := alias.Alias + "\x00" + string(resolved.ProviderID())
			if !seen[key] {
				seen[key] = true
				out = append(out, modelalias.DisplayModel{Alias: alias.Alias, Target: alias.Target, Provider: string(resolved.ProviderID())})
			}
		}
	}
	return out, nil
}
