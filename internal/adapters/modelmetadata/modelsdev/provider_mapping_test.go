package modelsdev_test

import (
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/modelmetadata/modelsdev"
)

// TestLookupResolvesMappedProviders 验证每个已登记的 Provider 都能命中真实快照条目。
//
// 这条用例的作用是钉住命名空间映射：写错一个 models.dev 命名空间（例如把 zcode 映到
// zhipu 而不是 zhipuai）不会报错，只会静默退化成「查不到 → 纯文本」，进而让 vision guard
// 把能看图的模型误判成纯文本。因此这里用快照里确实存在的模型 ID 逐个验证。
func TestLookupResolvesMappedProviders(t *testing.T) {
	t.Parallel()

	index, err := modelsdev.New()
	if err != nil {
		t.Fatalf("modelsdev.New() error = %v", err)
	}

	tests := []struct {
		providerID string
		modelID    string
	}{
		{providerID: "codex", modelID: "gpt-5-codex"},
		{providerID: "claude", modelID: "claude-sonnet-4-6"},
		{providerID: "gemini", modelID: "gemini-2.5-pro"},
		{providerID: "agy", modelID: "gemini-3.1-flash-image"},
		{providerID: "grok", modelID: "grok-4.5"},
		{providerID: "kimi", modelID: "kimi-k2.5"},
		{providerID: "zcode", modelID: "glm-5.2"},
	}

	for _, test := range tests {
		t.Run(test.providerID+"/"+test.modelID, func(t *testing.T) {
			t.Parallel()
			modalities, found := index.LookupModalities(test.providerID, test.modelID)
			if !found {
				t.Fatalf(
					"LookupModalities(%q, %q) missed; the models.dev namespace mapping is wrong",
					test.providerID,
					test.modelID,
				)
			}
			if len(modalities.Input()) == 0 || len(modalities.Output()) == 0 {
				t.Fatalf("modalities = %#v", modalities)
			}
		})
	}
}

// TestLookupLeavesAggregatorsUnmapped 验证聚合类 Provider 刻意不登记命名空间。
//
// opencode / qoder / codebuddy 家族的模型 ID 来自多个厂商，映射到任何单一命名空间都会
// 查错，因此宁可查不到也不猜；消费方（vision guard）用家族兜底处理它们。
func TestLookupLeavesAggregatorsUnmapped(t *testing.T) {
	t.Parallel()

	index, err := modelsdev.New()
	if err != nil {
		t.Fatalf("modelsdev.New() error = %v", err)
	}
	for _, providerID := range []string{
		"opencode",
		"qoder",
		"qodercn",
		"kiro",
		"codebuddy",
		"codebuddycn",
		"workbuddy",
		"workbuddycn",
	} {
		if _, found := index.LookupModalities(providerID, "glm-5.2"); found {
			t.Fatalf(
				"provider %q must stay unmapped so aggregator model ids are not resolved against a single vendor namespace",
				providerID,
			)
		}
	}
}

// TestLookupRejectsUnknownModelUnderMappedProvider 验证映射命中但模型不存在时仍返回未命中。
func TestLookupRejectsUnknownModelUnderMappedProvider(t *testing.T) {
	t.Parallel()

	index, err := modelsdev.New()
	if err != nil {
		t.Fatalf("modelsdev.New() error = %v", err)
	}
	if _, found := index.LookupModalities("grok", "definitely-not-a-real-model"); found {
		t.Fatal("unknown model must not resolve")
	}
}
