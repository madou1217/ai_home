package inferencegateway

import (
	"context"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
)

// ResolveModel projects the same ordered candidate plan as Resolve for a known
// capability set. Catalog consumers need no synthetic messages or provider I/O.
// The shared collector retains exact/wildcard precedence and candidate limits.
func (catalog *RouteCatalog) ResolveModel(ctx context.Context, protocol inference.ClientProtocolID, model string, required inference.CapabilitySet) (RoutePlan, error) {
	id, err := runtimecore.NewModelID(model)
	if catalog == nil || ctx == nil || !protocol.IsValid() || err != nil || id.String() != model || !required.IsValid() {
		return RoutePlan{}, ErrInvalidRouteResolution
	}
	if err := ctx.Err(); err != nil {
		return RoutePlan{}, err
	}
	collector := routeCollector{required: required}
	collector.addRules(catalog.exact[model], model, protocol)
	if !collector.full() {
		collector.addRules(catalog.wildcards, model, protocol)
	}
	return collector.plan()
}
