package inferencegateway

import (
	"context"
	"strings"

	"github.com/madou1217/ai_home/core/inference"
)

type accountProxyContextKey struct{}

// AccountEgressResolver 返回账号当前应使用的出口代理。
// required=true 表示账号绑定了出口；url 为空时调用方必须失败关闭。
type AccountEgressResolver interface {
	ResolveAccountProxy(
		ctx context.Context,
		provider inference.ProviderID,
		accountRef string,
	) (proxyURL string, required bool, err error)
}

// WithAccountProxyURL 把本次上游调用的账号出口代理写入 Context。
func WithAccountProxyURL(ctx context.Context, proxyURL string) context.Context {
	value := strings.TrimSpace(proxyURL)
	if value == "" {
		return ctx
	}
	return context.WithValue(ctx, accountProxyContextKey{}, value)
}

// AccountProxyURL 读取本次上游调用的账号出口代理；空串表示直连。
func AccountProxyURL(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	value, _ := ctx.Value(accountProxyContextKey{}).(string)
	return strings.TrimSpace(value)
}
