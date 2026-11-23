// Package fixture 为既有测试提供与生产同源的能力目录。
//
// 它使用冻结能力基线 + 家族推断，不依赖任何已删除的第三方快照；仅用于测试装配，
// 不进入服务器组合根。
package fixture

import (
	"github.com/madou1217/ai_home/application/modelmetadata"
	capabilitybaseline "github.com/madou1217/ai_home/contracts/model-capabilities"
	"github.com/madou1217/ai_home/internal/adapters/modelcapabilities/contract"
)

// New 返回基于契约基线的能力目录。
func New() (*modelmetadata.CapabilityRegistry, error) {
	source, err := contract.New(capabilitybaseline.Embedded())
	if err != nil {
		return nil, err
	}
	registry := modelmetadata.NewCapabilityRegistry(modelmetadata.CapabilityRegistryOptions{
		Sources:  []modelmetadata.FactsSource{source},
		SourceID: "fixture",
	})
	// 既有测试使用了一些当前目录里不可路由的固定模型 ID；补上它们的最小事实，
	// 保持测试意图不变（仅测试装配；生产契约不包含这些条目）。
	if err := registry.MergeModelFacts("codex", []modelmetadata.ModelFacts{
		fixtureFact("gpt-5", "GPT-5", []string{"text", "image"}, 400000),
		fixtureFact("gpt-5.3-codex", "GPT-5.3 Codex", []string{"text", "image"}, 400000),
	}); err != nil {
		return nil, err
	}
	if err := registry.MergeModelFacts("claude", []modelmetadata.ModelFacts{
		fixtureFact("claude-sonnet-4-5", "Claude Sonnet 4.5", []string{"text", "image", "pdf"}, 200000),
	}); err != nil {
		return nil, err
	}
	return registry, nil
}

func fixtureFact(modelID, name string, input []string, context int) modelmetadata.ModelFacts {
	fact := modelmetadata.ModelFacts{ModelID: modelID, DisplayName: name, ContextWindow: context}
	if modalities, err := modelmetadata.NewModalities(input, []string{"text"}); err == nil {
		fact.HasModalities = true
		fact.Modalities = modalities
	}
	return fact
}
