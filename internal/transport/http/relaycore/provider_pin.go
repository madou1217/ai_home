package relaycore

import (
	"context"
	"strings"
)

// providerPinKey 是请求上下文里的 Provider 钉选键。
type providerPinKey struct{}

// WithProviderPin 把 Provider 钉选放进请求上下文。
//
// 账号来源链据此只询问该 Provider 的来源：模型命名空间前缀把 Provider
// 钉死之后，裸 id 不能再去别家的池子里漂。
func WithProviderPin(ctx context.Context, provider string) context.Context {
	provider = strings.ToLower(strings.TrimSpace(provider))
	if ctx == nil || provider == "" {
		return ctx
	}
	return context.WithValue(ctx, providerPinKey{}, provider)
}

// ProviderPin 读取 Provider 钉选；空表示未钉选。
func ProviderPin(ctx context.Context) (string, bool) {
	if ctx == nil {
		return "", false
	}
	provider, ok := ctx.Value(providerPinKey{}).(string)
	provider = strings.ToLower(strings.TrimSpace(provider))
	return provider, ok && provider != ""
}
