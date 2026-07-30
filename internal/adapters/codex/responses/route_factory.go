package responses

import (
	"github.com/madou1217/ai_home/application/inferencecatalog"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
)

// 编译期确认真实 Adapter 同时声明其生产路由合同。
var _ inferencecatalog.ProviderRouteFactory = (*Adapter)(nil)

// ProviderID 返回 Adapter 唯一拥有的 Codex 账号域。
func (*Adapter) ProviderID() inference.ProviderID {
	return inference.ProviderCodex
}

// BuildRoute 为一个真实 Codex 模型创建 Responses 协议路由。
func (adapter *Adapter) BuildRoute(
	modelID runtimecore.ModelID,
) (inferencegateway.Route, error) {
	if adapter == nil || !modelID.IsValid() {
		return inferencegateway.Route{}, ErrInvalidRouteModel
	}
	capabilities, err := codexRouteCapabilities()
	if err != nil {
		return inferencegateway.Route{}, err
	}
	return inferencegateway.NewRoute(
		inference.ProviderCodex,
		inference.ProtocolCodexResponses,
		modelID.String(),
		capabilities,
	)
}

// codexRouteCapabilities 返回 Encoder 与 Decoder 已完整覆盖的 Canonical 能力。
func codexRouteCapabilities() (inference.CapabilitySet, error) {
	return inference.NewCapabilitySet(
		inference.CapabilityTextGeneration,
		inference.CapabilityImageInput,
		inference.CapabilityDocumentInput,
		inference.CapabilityTools,
		inference.CapabilityReasoning,
		inference.CapabilityStructuredOutput,
		inference.CapabilityStreaming,
	)
}
