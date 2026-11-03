package inferenceapi

import (
	"context"
	"net/http"

	pluginruntime "github.com/madou1217/ai_home/application/pluginruntime"
)

// PluginHandbackHeader 标记「这个入口没有内建该能力的中间件，交还前置宿主执行同一代插件」。
//
// 与 DecodeRejectedHeader 并存：回退链只认后者（必须是 4xx 且无副作用），能力名让宿主把
// 这次交还计入插件回落原因，而不是解码拒收计数。
const PluginHandbackHeader = "X-AIH-Plugin-Handback"

// MarkPluginHandback 在写出错误响应前标记本次交还来自插件能力缺口。
func MarkPluginHandback(response http.ResponseWriter, capability string) {
	response.Header().Set(DecodeRejectedHeader, "1")
	response.Header().Set(PluginHandbackHeader, capability)
}

// MarkAttemptHandback 标记请求固定的代次需要 gateway.attempt 中间件，而当前入口没有它。
func MarkAttemptHandback(response http.ResponseWriter) {
	MarkPluginHandback(response, pluginruntime.CapabilityGatewayAttempt)
}

// RequiresAttemptHandback 报告请求固定的插件代次是否有 gateway.attempt 贡献项。
//
// 只有内建了尝试中间件的入口（Canonical Coordinator）能执行它；native 快路径必须交还
// 前置宿主，绝不能静默跳过中间件——那会让插件以为自己在跑，实际一次都没执行。
func RequiresAttemptHandback(ctx context.Context) bool {
	pin := pluginruntime.PinFrom(ctx)
	return pin != nil && pin.Projection.Has(pluginruntime.CapabilityGatewayAttempt)
}
