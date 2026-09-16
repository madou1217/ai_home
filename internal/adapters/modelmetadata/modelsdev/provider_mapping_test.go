package modelsdev_test

import (
	"strings"
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

// TestLookupOrInferFallsBackToVisionFamilies 验证未收录模型按保守家族兜底。
//
// 快照覆盖不了全部 provider 自定义模型名，因此判定必须是「总是有答案」的：已知视觉家族
// 推断为能看图，其余推断为纯文本（未命中）。方向刻意保守——把能看图的模型判成纯文本只是
// 多剥一张图，反过来会让请求带着图片打到看不见图片的上游、整条被 400 拒绝。
func TestLookupOrInferFallsBackToVisionFamilies(t *testing.T) {
	t.Parallel()

	index := newIndex(t)
	for _, model := range []string{
		"claude-opus-5",
		"gemini-3.5-flash",
		// 当前主力模型：家族表按主版本号判定，不枚举具体版本。
		"gpt-5.5",
		"gpt-5.6-sol",
		"gpt-6-astra",
		// 版本分隔符归一化：点号版本与横线版本命中同一条规则。
		"gpt-5-5",
		"o4-mini",
	} {
		modalities, found := index.LookupOrInferModalities("unmapped-provider", model)
		if !found {
			t.Fatalf("vision family %q should be inferred", model)
		}
		if !supportsImageInput(modalities.Input()) {
			t.Fatalf("vision family %q inferred as %v", model, modalities.Input())
		}
	}
}

// TestLookupOrInferNeverClaimsVisionForTextOnlyFamilies 验证纯文本家族不会被判成能看图。
//
// 这里不断言「未命中」：`gpt-3.5-turbo` 这类模型在快照里存在，基座回退会解析到它们并
// 如实返回纯文本——那比未命中更权威。真正要守住的性质是「不谎称能看图」：谎称会让请求
// 带着图片打到看不见图片的上游，整条被 400 拒绝。
func TestLookupOrInferNeverClaimsVisionForTextOnlyFamilies(t *testing.T) {
	t.Parallel()

	index := newIndex(t)
	for _, model := range []string{
		"future-unknown-model",
		"gpt-3.5-turbo",
		"gpt-oss-120b",
		"text-embedding-3-small",
	} {
		modalities, found := index.LookupOrInferModalities("unmapped-provider", model)
		if found && supportsImageInput(modalities.Input()) {
			t.Fatalf(
				"model %q must not be inferred as vision-capable: %v",
				model,
				modalities.Input(),
			)
		}
	}
	// 完全认不出来的名字必须是未命中，而不是伪造一个答案。
	if _, found := index.LookupOrInferModalities("unmapped-provider", "future-unknown-model"); found {
		t.Fatal("an unrecognizable model must stay unresolved")
	}
}

// TestVisionFamilyTableAgreesWithSnapshot 用权威快照反查家族表，防止它随时间腐坏。
//
// 动机来自一次真实腐坏：家族表原先把 OpenAI 写成枚举 `gpt-(4o|4[.-]1|5)`，目录里出现
// gpt-6 之后，枚举表会把能看图的 gpt-6 判成纯文本，进而剥掉它的图片。因此这里用快照
// 逐条核对：命中的模型快照必须说含 image 输入；刻意排除的模型快照必须说是纯文本。
//
// 快照升级后如果某条断言失效，说明家族表该更新了，而不是放宽测试。
func TestVisionFamilyTableAgreesWithSnapshot(t *testing.T) {
	t.Parallel()

	index := newIndex(t)
	visionModels := []string{
		"gpt-5.5",
		"gpt-5.6-sol",
		"gpt-6-astra",
		"o4-mini",
		"claude-opus-5",
		"gemini-3.5-flash",
	}
	for _, model := range visionModels {
		modalities, found := index.LookupModalities("codex", model)
		if !found {
			t.Fatalf("snapshot is missing %q", model)
		}
		if !supportsImageInput(modalities.Input()) {
			t.Fatalf(
				"family table claims %q is vision-capable but the snapshot says %v",
				model,
				modalities.Input(),
			)
		}
	}

	textOnlyModels := []string{"gpt-3.5-turbo", "gpt-oss-120b"}
	for _, model := range textOnlyModels {
		modalities, found := index.LookupModalities("codex", model)
		if !found {
			t.Fatalf("snapshot is missing %q", model)
		}
		if supportsImageInput(modalities.Input()) {
			t.Fatalf("excluded model %q unexpectedly supports image input", model)
		}
	}
}

// TestLookupOrInferTreatsImageGenerationModelsAsImageCapable 验证图像生成模型既算
// image_out 也算 vision。
//
// 对应 Node 的 computeModelModalities 末段：命中 `IMAGE_MODEL_PATTERN` 的模型无条件补上
// image 输出，并补上 image 输入（它们多数也接受图片）。少补输入会让 vision guard 把用户
// 贴给 gemini-3.1-flash-image 的图剥掉；少补输出会让 `?capability=image_out` 漏掉这批模型。
//
// 这条规则对**快照命中**与**家族兜底**两条路径都要生效，因此两条都断言。
func TestLookupOrInferTreatsImageGenerationModelsAsImageCapable(t *testing.T) {
	t.Parallel()

	index := newIndex(t)
	// 前两条来自快照（google 命名空间），后两条只能靠图像生成家族兜底认出来。
	for _, model := range []string{
		"gemini-3.1-flash-image",
		"gemini-2.5-flash-image",
		"nano-banana",
		"nano-banana-pro",
	} {
		modalities, found := index.LookupOrInferModalities("gemini", model)
		if !found {
			t.Fatalf("image generation model %q should resolve", model)
		}
		if !supportsImageInput(modalities.Input()) {
			t.Fatalf("image generation model %q must accept image input: %v", model, modalities.Input())
		}
		if !supportsImageOutput(modalities.Output()) {
			t.Fatalf("image generation model %q must emit image output: %v", model, modalities.Output())
		}
	}

	// 反向：纯文本模型不得被这条规则误伤。
	for _, model := range []string{"gpt-5.6-sol", "claude-opus-5", "gpt-oss-120b"} {
		modalities, found := index.LookupOrInferModalities("codex", model)
		if !found {
			t.Fatalf("snapshot is missing %q", model)
		}
		if supportsImageOutput(modalities.Output()) {
			t.Fatalf("text model %q must not claim image output: %v", model, modalities.Output())
		}
	}
}

// supportsImageInput 判断模态列表是否包含 image。
func supportsImageInput(values []string) bool {
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), "image") {
			return true
		}
	}
	return false
}

// supportsImageOutput 与 supportsImageInput 同义，单独命名以让调用点表达意图。
func supportsImageOutput(values []string) bool {
	return supportsImageInput(values)
}
