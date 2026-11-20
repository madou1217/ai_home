package inferenceapi

import (
	"strings"

	"github.com/madou1217/ai_home/core/inference"
)

// ModelPrefixResolver 把客户端显式写出的 provider 命名空间（如 zcode/）解析成
// 宿主声明的 Provider。返回 false 表示该前缀未被任何 Provider 声明，调用方不得改写。
type ModelPrefixResolver interface {
	ResolveModelPrefix(prefix string) (provider string, ok bool)
}

// ApplyProviderModelPrefix 在 Canonical 路由前把 provider 声明的前缀还原成裸模型，
// 并把 Provider 固定到解析结果。未声明前缀、完整模型已显式带 Provider 冲突时不改写。
//
// 这对应 Node 的 provider-model-prefix 入口语义：前缀不是全局剥离，只有 Provider
// 自己声明过的命名空间才会改写成「裸模型 + Provider 提示」。
func ApplyProviderModelPrefix(resolver ModelPrefixResolver, request inference.Request) inference.Request {
	if resolver == nil {
		return request
	}
	model := strings.TrimSpace(request.Model())
	separator := strings.IndexByte(model, '/')
	if separator <= 0 || separator >= len(model)-1 {
		return request
	}
	provider, ok := resolver.ResolveModelPrefix(model[:separator])
	provider = strings.ToLower(strings.TrimSpace(provider))
	if !ok || provider == "" {
		return request
	}
	if hint := strings.ToLower(strings.TrimSpace(request.ProviderHint())); hint != "" && hint != "auto" && hint != provider {
		return request
	}
	bare := strings.TrimSpace(model[separator+1:])
	if bare == "" {
		return request
	}
	return request.WithModel(bare).WithProviderHint(provider)
}
