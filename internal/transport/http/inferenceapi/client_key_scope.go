package inferenceapi

import (
	"errors"
	"net/http"

	"github.com/madou1217/ai_home/application/inferencegateway"
	coreclientkeys "github.com/madou1217/ai_home/core/clientkeys"
)

// ClientKeyScopeRejection 是客户端 Key 白名单拒绝的协议无关描述。
type ClientKeyScopeRejection struct {
	Status  int
	Code    string
	Message string
}

// ClientKeyScopeRejectionOf 识别路由层抛出的账号池/模型池白名单拒绝。
//
// 这类拒绝不是上游不可用：请求本身合法，只是这把 Key 无权使用该模型或账号池，
// 因此各协议编码器都应返回 4xx（403）而不是压成 503。
func ClientKeyScopeRejectionOf(err error) (ClientKeyScopeRejection, bool) {
	switch {
	case errors.Is(err, inferencegateway.ErrClientKeyModelForbidden):
		return ClientKeyScopeRejection{
			Status:  http.StatusForbidden,
			Code:    coreclientkeys.CodeModelNotAllowed,
			Message: coreclientkeys.MessageModelNotAllowed,
		}, true
	case errors.Is(err, inferencegateway.ErrClientKeyProviderForbidden):
		return ClientKeyScopeRejection{
			Status:  http.StatusForbidden,
			Code:    "provider_not_allowed",
			Message: "This API key is not allowed to use the requested account pool",
		}, true
	default:
		return ClientKeyScopeRejection{}, false
	}
}
