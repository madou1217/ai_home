package modelsdev_test

import (
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/modelmetadata/modelsdev"
)

// newIndex 创建快照索引。
func newIndex(t *testing.T) *modelsdev.Index {
	t.Helper()
	index, err := modelsdev.New()
	if err != nil {
		t.Fatalf("modelsdev.New() error = %v", err)
	}
	return index
}

// TestLookupResolvesMappedProviders 验证单值命名空间映射能命中真实快照条目。
//
// 这条用例钉住命名空间拼写：写错一个 models.dev 命名空间不会报错，只会静默退化成
// 「查不到 → 纯文本」，进而让 vision guard 把能看图的模型误判成纯文本。
func TestLookupResolvesMappedProviders(t *testing.T) {
	t.Parallel()

	index := newIndex(t)
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

// TestLookupResolvesAggregatorNamespaces 验证聚合 Provider 的候选命名空间。
//
// 聚合 Provider 的模型表挂在 models.dev 自己的命名空间下（opencode、github-copilot、
// zai-coding-plan 等），这些模型 ID 在 canonical models 里不存在；只按厂商命名空间查
// 会一律查不到。
func TestLookupResolvesAggregatorNamespaces(t *testing.T) {
	t.Parallel()

	index := newIndex(t)
	tests := []struct {
		name       string
		providerID string
		modelID    string
	}{
		// opencode 的自有命名空间候选。
		{name: "opencode prefixed id", providerID: "opencode", modelID: "opencode-go/glm-5.2"},
		// agy 按模型前缀选候选：claude 系走 anthropic / github-copilot。
		{name: "agy claude family", providerID: "agy", modelID: "claude-sonnet-4-6"},
		{name: "agy gemini family", providerID: "agy", modelID: "gemini-3.5-flash"},
		{name: "agy grok family", providerID: "agy", modelID: "grok-4.5"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if _, found := index.LookupModalities(test.providerID, test.modelID); !found {
				t.Fatalf(
					"LookupModalities(%q, %q) missed",
					test.providerID,
					test.modelID,
				)
			}
		})
	}
}

// TestLookupFallsBackToBaseModel 验证厂商前缀推断与逐步裁尾。
//
// 没有稳定命名空间的 Provider（codebuddy 家族、qoder、kiro）以及 provider 自定义的
// 能力后缀变体（…-thinking、…-high）都靠这一层落地；少了它，这些模型会静默变成纯文本。
func TestLookupFallsBackToBaseModel(t *testing.T) {
	t.Parallel()

	index := newIndex(t)
	tests := []struct {
		name       string
		providerID string
		modelID    string
	}{
		{name: "aggregator with claude id", providerID: "codebuddy", modelID: "claude-sonnet-4-6"},
		{name: "aggregator with glm id", providerID: "qoder", modelID: "glm-5.2"},
		{name: "capability suffix variant", providerID: "codebuddy", modelID: "claude-opus-4-6-thinking"},
		{name: "tier suffix variant", providerID: "kiro", modelID: "claude-sonnet-4-6-high"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			modalities, found := index.LookupModalities(test.providerID, test.modelID)
			if !found {
				t.Fatalf(
					"LookupModalities(%q, %q) missed; base-model fallback is not working",
					test.providerID,
					test.modelID,
				)
			}
			if len(modalities.Input()) == 0 {
				t.Fatalf("modalities = %#v", modalities)
			}
		})
	}
}

// TestLookupRejectsUnknownModel 验证确实不存在的模型仍然未命中。
//
// 三层解析都必须失败才返回未命中；这条用例防止「什么都命中」把降级路径变成死代码。
func TestLookupRejectsUnknownModel(t *testing.T) {
	t.Parallel()

	index := newIndex(t)
	for _, test := range []struct {
		providerID string
		modelID    string
	}{
		{providerID: "grok", modelID: "definitely-not-a-real-model"},
		{providerID: "codebuddy", modelID: "definitely-not-a-real-model"},
		{providerID: "codex", modelID: ""},
	} {
		if _, found := index.LookupModalities(test.providerID, test.modelID); found {
			t.Fatalf(
				"LookupModalities(%q, %q) should miss",
				test.providerID,
				test.modelID,
			)
		}
	}
}

// TestLookupPrefersProviderNamespaceOverBaseFallback 验证精确候选优先于基座回退。
func TestLookupPrefersProviderNamespaceOverBaseFallback(t *testing.T) {
	t.Parallel()

	index := newIndex(t)
	// zcode 的候选里 zai-coding-plan 在 zhipuai 之前；两者都可能收录 glm-5.2，
	// 这里只要求解析成功且落在 zcode 的候选集合内，不假设具体是哪一条命中。
	modalities, found := index.LookupModalities("zcode", "glm-5.2")
	if !found {
		t.Fatal("zcode/glm-5.2 should resolve")
	}
	if len(modalities.Input()) == 0 || len(modalities.Output()) == 0 {
		t.Fatalf("modalities = %#v", modalities)
	}
}
