package inferenceapi

import (
	"context"
	"net/http"

	"github.com/madou1217/ai_home/application/inferencegateway"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// ServedAccountRefHeader 告诉客户端哪个账号服务了本次请求（与 Node 宿主同名）。
	ServedAccountRefHeader = "x-aih-server-account-ref"
	// ServedProviderHeader 告诉客户端哪个 Provider 服务了本次请求。
	ServedProviderHeader = "x-aih-server-provider"
)

// ContextWithServedAccountHeaders 让每次单账号尝试在响应头提交前写入服务账号。
//
// 换号重试时后一次尝试覆盖前一次；响应头一旦提交，之后的写入不会出现在线上，
// 与「首个可见字节之后不再换号」的执行合同一致。
func ContextWithServedAccountHeaders(ctx context.Context, response http.ResponseWriter) context.Context {
	if response == nil {
		return ctx
	}
	return inferencegateway.WithAccountObserver(ctx, func(accountRef accountcore.AccountRef, providerID string) {
		response.Header().Set(ServedAccountRefHeader, accountRef.String())
		if providerID != "" {
			response.Header().Set(ServedProviderHeader, providerID)
		}
	})
}
