package modelsdev_test

import (
	"github.com/madou1217/ai_home/core/inference"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/modelmetadata/modelsdev"
)

// TestIndexResolvesCurrentCodexAndClaudeModels 验证嵌入快照来自当前 models.dev 数据。
func TestIndexResolvesCurrentCodexAndClaudeModels(t *testing.T) {
	t.Parallel()

	index, err := modelsdev.New()
	if err != nil {
		t.Fatalf("modelsdev.New() error = %v", err)
	}
	tests := []struct {
		providerID string
		modelID    string
		wantInput  []string
		wantOutput []string
	}{
		{
			providerID: "codex",
			modelID:    "gpt-5.6-sol",
			wantInput:  []string{"text", "image", "pdf"},
			wantOutput: []string{"text"},
		},
		{
			providerID: "claude",
			modelID:    "claude-opus-5",
			wantInput:  []string{"text", "image", "pdf"},
			wantOutput: []string{"text"},
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.providerID, func(t *testing.T) {
			t.Parallel()
			modalities, found := index.LookupModalities(test.providerID, test.modelID)
			if !found {
				t.Fatalf("LookupModalities(%q, %q) not found", test.providerID, test.modelID)
			}
			assertStrings(t, modalities.Input(), test.wantInput)
			assertStrings(t, modalities.Output(), test.wantOutput)
		})
	}
}

// TestIndexFailsClosedForUnknownModel 验证索引不会猜测未知模型能力。
//
// 注意「未知 Provider」与「未知模型」是两件事：没有命名空间映射的 Provider 仍可能承载
// 厂商自有模型 ID，基座回退会按模型名前缀解析它们（这是聚合 Provider 能查到模型的
// 唯一路径）。只有模型本身也认不出来时才必须未命中。
func TestIndexFailsClosedForUnknownModel(t *testing.T) {
	t.Parallel()

	index, err := modelsdev.New()
	if err != nil {
		t.Fatalf("modelsdev.New() error = %v", err)
	}
	if _, found := index.LookupModalities("codex", "future-unknown-model"); found {
		t.Fatal("unknown model unexpectedly found")
	}
	if _, found := index.LookupModalities("unknown-provider", "future-unknown-model"); found {
		t.Fatal("unknown provider with unknown model unexpectedly found")
	}
	// 未映射 Provider + 厂商自有模型 ID：应当由基座回退解析，而不是静默降级为纯文本。
	if _, found := index.LookupModalities("unknown-provider", "gpt-5.6-sol"); !found {
		t.Fatal("unmapped provider serving a known vendor model should resolve via the base fallback")
	}
}

// assertStrings 验证字符串列表的顺序和值都与 models.dev 一致。
func assertStrings(t *testing.T, got []string, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("strings = %#v, want %#v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("strings = %#v, want %#v", got, want)
		}
	}
}

// TestIndexResolvesReasoningLadders 验证档位查询走与模态相同的三层解析。
func TestIndexResolvesReasoningLadders(t *testing.T) {
	t.Parallel()
	index, err := modelsdev.New()
	if err != nil {
		t.Fatalf("modelsdev.New() error = %v", err)
	}
	ladder, found := index.LookupReasoningEfforts("codex", "gpt-5.6-sol")
	if !found {
		t.Fatal("gpt-5.6-sol must declare a reasoning ladder")
	}
	assertStrings(t, effortStrings(ladder), []string{"none", "low", "medium", "high", "xhigh", "max"})
	// provider 自定义的档位后缀（…-high）落到基座模型的阶梯上。
	suffixed, found := index.LookupReasoningEfforts("codex", "gpt-5.6-sol-high")
	if !found {
		t.Fatal("a suffixed variant must fall back to the base model ladder")
	}
	assertStrings(t, effortStrings(suffixed), effortStrings(ladder))
	// 没有档位概念的模型如实未命中，不做家族兜底。
	if _, found := index.LookupReasoningEfforts("codex", "not-a-real-model"); found {
		t.Fatal("unknown models must not report a guessed ladder")
	}
}

// effortStrings 把档位枚举转成断言用的字符串切片。
func effortStrings(values []inference.ReasoningEffort) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		out = append(out, string(value))
	}
	return out
}
