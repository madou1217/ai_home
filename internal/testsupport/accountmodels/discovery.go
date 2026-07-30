// Package accountmodels 提供不会访问网络的账号模型测试策略。
package accountmodels

import (
	"context"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

// NewDiscovery 创建 Codex 与 Claude 均返回单个确定模型的测试注册表。
func NewDiscovery(catalog *providers.Catalog) (*accountapp.ModelDiscovery, error) {
	return accountapp.NewModelDiscovery(catalog, NewDiscoverers())
}

// NewDiscoverers 返回可直接注入 Host 或命令测试的确定性策略集合。
func NewDiscoverers() []accountapp.ProviderModelDiscoverer {
	return []accountapp.ProviderModelDiscoverer{
		fixedDiscoverer{
			providerID: "codex",
			modelID:    "gpt-5.6-sol",
		},
		fixedDiscoverer{
			providerID: "claude",
			modelID:    "claude-sonnet-4",
		},
	}
}

// fixedDiscoverer 返回一个 Provider 的确定性完整模型集合。
type fixedDiscoverer struct {
	providerID string
	modelID    string
}

func (discoverer fixedDiscoverer) ProviderID() string {
	return discoverer.providerID
}

func (discoverer fixedDiscoverer) DiscoverModels(
	context.Context,
	accountapp.Credential,
) ([]string, error) {
	return []string{discoverer.modelID}, nil
}
