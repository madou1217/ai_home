package inferenceapi

import (
	"errors"

	"github.com/madou1217/ai_home/application/inferencegateway"
)

// PluginRejectionOf 返回 gateway.attempt 中间件拒绝本次尝试的公开信息。
//
// 插件拒绝是请求级裁决，不是上游故障：传输层必须按插件给的状态码与稳定码写出响应
// （与 Node 的 createAttemptMiddleware → writePluginError 一致），不能压成 503。
func PluginRejectionOf(err error) (*inferencegateway.PluginRejection, bool) {
	var rejection *inferencegateway.PluginRejection
	if errors.As(err, &rejection) && rejection != nil {
		return rejection, true
	}
	return nil, false
}
