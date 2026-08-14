package codeassist

import (
	"errors"

	"github.com/madou1217/ai_home/application/inferencecatalog"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
)

var ErrInvalidRouteModel = errors.New("AGY Code Assist 路由模型无效")

var _ inferencecatalog.ProviderRouteFactory = (*Adapter)(nil)

func (*Adapter) ProviderID() inference.ProviderID { return inference.ProviderAgy }

func (adapter *Adapter) BuildRoute(
	modelID runtimecore.ModelID,
) (inferencegateway.Route, error) {
	if adapter == nil || !modelID.IsValid() {
		return inferencegateway.Route{}, ErrInvalidRouteModel
	}
	capabilities, err := inference.NewCapabilitySet(
		inference.CapabilityTextGeneration,
		inference.CapabilityTools,
		inference.CapabilityStreaming,
	)
	if err != nil {
		return inferencegateway.Route{}, err
	}
	return inferencegateway.NewRoute(
		inference.ProviderAgy,
		inference.ProtocolAgyCodeAssist,
		modelID.String(),
		capabilities,
	)
}
