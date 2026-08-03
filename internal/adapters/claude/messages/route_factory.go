package messages

import (
	"github.com/madou1217/ai_home/application/inferencecatalog"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
)

// 编译期确认真实 Adapter 同时声明其生产路由合同。
var _ inferencecatalog.ProviderRouteFactory = (*Adapter)(nil)

// ProviderID 返回 Adapter 唯一拥有的 Claude 账号域。
func (*Adapter) ProviderID() inference.ProviderID {
	return inference.ProviderClaude
}

// BuildRoute 为一个真实 Claude 模型创建 Messages 协议路由。
func (adapter *Adapter) BuildRoute(
	modelID runtimecore.ModelID,
) (inferencegateway.Route, error) {
	if adapter == nil || !modelID.IsValid() {
		return inferencegateway.Route{}, ErrInvalidRouteModel
	}
	capabilities, err := claudeRouteCapabilities()
	if err != nil {
		return inferencegateway.Route{}, err
	}
	return inferencegateway.NewRoute(
		inference.ProviderClaude,
		inference.ProtocolClaudeMessages,
		modelID.String(),
		capabilities,
	)
}

// claudeRouteCapabilities 返回 Encoder 与 Decoder 已完整覆盖的 Canonical 能力。
func claudeRouteCapabilities() (inference.CapabilitySet, error) {
	return inference.NewCapabilitySet(
		inference.CapabilityTextGeneration,
		inference.CapabilityImageInput,
		inference.CapabilityDocumentInput,
		inference.CapabilityTools,
		inference.CapabilityReasoning,
		inference.CapabilityStructuredOutput,
		inference.CapabilityStreaming,
		inference.CapabilityWebSearch,
	)
}
