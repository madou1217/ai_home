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
	// Code Assist 上的模型默认思考：带 reasoning 配置或历史的请求（Claude Code thinking、
	// Codex reasoning.effort）必须能路由到这里，否则整条路由因能力不足 503（生产 WebUI agy 会话）。
	// 编码器不改写 thinkingConfig（模型按默认思考），并丢弃历史 reasoning 内容。
	capabilities, err := inference.NewCapabilitySet(
		inference.CapabilityTextGeneration,
		inference.CapabilityTools,
		inference.CapabilityStreaming,
		inference.CapabilityReasoning,
		// 与 Node 一致：Code Assist 线路只投递 function 工具，服务器侧搜索工具（codex CLI 总会带
		// web_search）被忽略而不是让整条路由失败。
		inference.CapabilityWebSearch,
		// Code Assist 上的 Gemini 与 Claude 模型都接受内联图片（agy relay soak：看图请求曾 503）。
		inference.CapabilityImageInput,
		// Claude Code 总带 context_management（clear_thinking 等）。编码器本就丢弃全部历史思考，
		// 清理思考的编辑天然满足，不需要上游执行（Claude Code 经 agy 曾因此 503）。
		inference.CapabilityContextManagement,
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
