package inferenceapi

import (
	"context"

	pluginruntime "github.com/madou1217/ai_home/application/pluginruntime"
)

// RequiresAttemptMiddleware 报告请求固定的插件代次是否有 gateway.attempt 贡献项。
//
// 只有内建了尝试中间件的入口（Canonical Coordinator）能执行它；native 快路径
// 必须把请求转交给 Canonical，绝不能静默跳过中间件——那会让插件以为自己在跑，
// 实际一次都没执行。
func RequiresAttemptMiddleware(ctx context.Context) bool {
	pin := pluginruntime.PinFrom(ctx)
	return pin != nil && pin.Projection.Has(pluginruntime.CapabilityGatewayAttempt)
}
