package responses

import (
	"context"
	"fmt"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/modelmetadata"
	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/internal/adapters/clientversion"
)

// ModelCatalogSource 是 Codex 账号管理写路径使用的远端目录适配器。
type ModelCatalogSource struct {
	client   HTTPClient
	versions clientversion.Source
	// facts 可选：把上游目录声明的能力事实（档位/模态/上下文/显示名）登记为运行时事实。
	facts modelmetadata.ModelFactsRegistrar
}

// 编译期确认 Codex 目录源实现统一 Provider 发现策略。
var _ accountapp.ProviderModelDiscoverer = (*ModelCatalogSource)(nil)

// NewModelCatalogSource 创建只供账号管理写路径调用的 Codex 模型发现适配器。
func NewModelCatalogSource(client HTTPClient) (*ModelCatalogSource, error) {
	return NewModelCatalogSourceWithClientVersion(client, clientversion.Static(""))
}

// NewModelCatalogSourceWithClientVersion 创建按版本来源请求目录的发现适配器。
func NewModelCatalogSourceWithClientVersion(
	client HTTPClient,
	versions clientversion.Source,
) (*ModelCatalogSource, error) {
	if client == nil || versions == nil {
		return nil, ErrInvalidDependencies
	}
	return &ModelCatalogSource{client: client, versions: versions}, nil
}

// ProviderID 返回该发现策略唯一支持的 Codex Provider。
func (source *ModelCatalogSource) ProviderID() string {
	return codexauth.ProviderID
}

// WithModelFacts 让目录发现把上游声明的能力事实登记到运行时注册表。
//
// 没有这条通道时，新模型的档位/模态/上下文要等第三方快照升级并重新发版才会出现。
// registrar 为 nil 时保持只刷新模型 ID 的旧行为。
func (source *ModelCatalogSource) WithModelFacts(
	registrar modelmetadata.ModelFactsRegistrar,
) *ModelCatalogSource {
	if source != nil {
		source.facts = registrar
	}
	return source
}

// DiscoverModels 在账号管理阶段读取一次完整目录并返回独立切片。
func (source *ModelCatalogSource) DiscoverModels(
	ctx context.Context,
	credential accountapp.Credential,
) ([]string, error) {
	if source == nil ||
		source.client == nil ||
		ctx == nil ||
		credential == nil ||
		credential.ProviderID() != codexauth.ProviderID {
		return nil, ErrInvalidInvocation
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	auth, err := projectAuth(credential)
	auth.clientVersion = source.versions.Current()
	if err != nil {
		return nil, err
	}
	catalog, err := fetchModelCatalog(ctx, source.client, auth)
	if err != nil {
		return nil, err
	}
	if source.facts != nil && len(catalog.facts) > 0 {
		if err := source.facts.MergeModelFacts(codexauth.ProviderID, catalog.facts); err != nil {
			return nil, fmt.Errorf("发布模型能力事实失败: %w", err)
		}
	}
	return append([]string(nil), catalog.models...), nil
}
