package responses

import (
	"github.com/madou1217/ai_home/application/inferencecatalog"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
)

// 编译期确认真实 Adapter 同时声明其生产路由合同。
var _ inferencecatalog.ProviderRouteFactory = (*Adapter)(nil)
var _ inferencecatalog.ProviderRouteVariants = (*Adapter)(nil)

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

// BuildRouteVariants 在 Responses 之外声明一条 Messages 候选。
//
// 双协议厂商（千问、DeepSeek、百炼…）的 Anthropic 兼容端点由 Messages Adapter
// 承载。路由目录为每个 codex 模型同时编译两条候选，具体账号能不能走这条路由由
// 征召期的凭据策略逐账号判定：没有厂商 Anthropic 端点的账号会被跳过，候选自动
// 回落到 Responses，既有纯 OpenAI 账号的行为不变。
func (adapter *Adapter) BuildRouteVariants(
	modelID runtimecore.ModelID,
) ([]inferencegateway.Route, error) {
	primary, err := adapter.BuildRoute(modelID)
	if err != nil {
		return nil, err
	}
	capabilities, err := vendorMessagesRouteCapabilities()
	if err != nil {
		return nil, err
	}
	variant, err := inferencegateway.NewRoute(
		inference.ProviderCodex,
		inference.ProtocolClaudeMessages,
		modelID.String(),
		capabilities,
	)
	if err != nil {
		return nil, err
	}
	return []inferencegateway.Route{primary, variant}, nil
}

// vendorMessagesRouteCapabilities 是厂商 Anthropic 兼容端点可承诺的能力。
//
// 刻意不含 web search、document 与 context management：这些是 Anthropic 官方
// 端点的能力，第三方兼容层没有合同保证；请求需要它们时停留在 Responses 候选，
// 由适配层按既有跨协议规则处理，而不是让 Messages 候选在运行时失败。
func vendorMessagesRouteCapabilities() (inference.CapabilitySet, error) {
	return inference.NewCapabilitySet(
		inference.CapabilityTextGeneration,
		inference.CapabilityImageInput,
		inference.CapabilityTools,
		inference.CapabilityReasoning,
		inference.CapabilityStructuredOutput,
		inference.CapabilityStreaming,
	)
}

// codexRouteCapabilities 返回 Encoder 已覆盖或有明确跨协议投影的 Canonical 能力。
func codexRouteCapabilities() (inference.CapabilitySet, error) {
	return inference.NewCapabilitySet(
		inference.CapabilityTextGeneration,
		inference.CapabilityImageInput,
		inference.CapabilityDocumentInput,
		inference.CapabilityTools,
		inference.CapabilityReasoning,
		inference.CapabilityStructuredOutput,
		inference.CapabilityStreaming,
		inference.CapabilityWebSearch,
		// Claude context_management 在 Codex 上游没有等价字段；跨协议时由
		// Encoder 丢弃，必须仍进入路由候选，不能在能力筛选阶段制造 503。
		inference.CapabilityContextManagement,
	)
}
