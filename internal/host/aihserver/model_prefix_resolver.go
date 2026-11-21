package aihserver

import (
	"context"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/modelprefix"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

// relayModelPrefixResolver 把 Provider 合同的命名空间声明接到 relay 模型入口。
//
// 完整 id 优先：只要请求里的字面量本身在可路由模型目录中存在，就不改写。
// 这是 Node 侧同一议事规则（已存在的完整 id 永远优先），避免把
// `cline-pass/glm-5.3` 这类真实模型误当成未声明的前缀写法。
type relayModelPrefixResolver struct {
	prefixes *modelprefix.Resolver
	models   accountapp.RoutableModelReader
}

var _ relaycore.ModelPrefixResolver = (*relayModelPrefixResolver)(nil)

// newRelayModelPrefixResolver 编译一次合同索引；目录或模型读取端口缺失时返回 nil，
// 让调用方保持原有行为而不是带着半份合同上线。
func newRelayModelPrefixResolver(
	catalog *providers.Catalog,
	models accountapp.RoutableModelReader,
) *relayModelPrefixResolver {
	if catalog == nil || models == nil {
		return nil
	}
	return &relayModelPrefixResolver{
		prefixes: modelprefix.New(catalog.List()),
		models:   models,
	}
}

// ResolveModelPrefix 返回裸模型与应钉死的 Provider；未声明的前缀不解析。
func (resolver *relayModelPrefixResolver) ResolveModelPrefix(
	ctx context.Context,
	model string,
) (string, string, bool) {
	if resolver == nil || resolver.prefixes == nil || resolver.models == nil {
		return "", "", false
	}
	bare, provider, ok := resolver.prefixes.Resolve(model)
	if !ok {
		return "", "", false
	}
	full := strings.TrimSpace(model)
	models, err := resolver.models.ListRoutableModels(ctx)
	if err != nil {
		return "", "", false
	}
	for _, item := range models {
		if item.ModelID().String() == full {
			return "", "", false
		}
	}
	return bare, provider, true
}
