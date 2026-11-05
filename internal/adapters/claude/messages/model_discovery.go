package messages

import (
	"context"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
)

// ModelCatalogSource 是 Claude 账号管理写路径使用的远端目录适配器。
type ModelCatalogSource struct {
	client HTTPClient
}

// 编译期确认 Claude 目录源实现统一 Provider 发现策略。
var _ accountapp.ProviderModelDiscoverer = (*ModelCatalogSource)(nil)

// NewModelCatalogSource 创建只供账号管理写路径调用的 Claude 模型发现适配器。
func NewModelCatalogSource(client HTTPClient) (*ModelCatalogSource, error) {
	if client == nil {
		return nil, ErrInvalidDependencies
	}
	return &ModelCatalogSource{client: client}, nil
}

// ProviderID 返回该发现策略唯一支持的 Claude Provider。
func (source *ModelCatalogSource) ProviderID() string {
	return claudeauth.ProviderID
}

// DiscoverModels 在账号管理阶段读取完整分页目录并返回独立切片。
func (source *ModelCatalogSource) DiscoverModels(
	ctx context.Context,
	credential accountapp.Credential,
) ([]string, error) {
	if source == nil ||
		source.client == nil ||
		ctx == nil ||
		credential == nil ||
		credential.ProviderID() != claudeauth.ProviderID {
		return nil, ErrInvalidInvocation
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	auth, err := projectModelCatalogAuth(credential)
	if err != nil {
		return nil, err
	}
	catalog, err := fetchModelCatalog(ctx, source.client, auth)
	if err != nil {
		return nil, err
	}
	return append([]string(nil), catalog.models...), nil
}
