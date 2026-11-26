package inferenceapi

import (
	"errors"

	"github.com/madou1217/ai_home/application/inferencegateway"
)

// IsRouteNotFound 判断执行错误是否表示请求的模型没有任何可路由 Provider。
//
// 这与“路由存在但没有可用账号”（ErrNoRoutableAccount）不同：前者是客户端
// 请求了不存在的模型，标准协议应返回 404/not_found，而不是可重试的 503。
func IsRouteNotFound(err error) bool {
	return errors.Is(err, inferencegateway.ErrRouteNotFound)
}
