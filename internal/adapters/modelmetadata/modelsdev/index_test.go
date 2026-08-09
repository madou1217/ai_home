package modelsdev_test

import (
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
func TestIndexFailsClosedForUnknownModel(t *testing.T) {
	t.Parallel()

	index, err := modelsdev.New()
	if err != nil {
		t.Fatalf("modelsdev.New() error = %v", err)
	}
	if _, found := index.LookupModalities("codex", "future-unknown-model"); found {
		t.Fatal("unknown model unexpectedly found")
	}
	if _, found := index.LookupModalities("unknown-provider", "gpt-5.6-sol"); found {
		t.Fatal("unknown provider unexpectedly found")
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
