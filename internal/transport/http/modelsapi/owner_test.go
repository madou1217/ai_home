package modelsapi

import "testing"

// TestResolveModelOwnerMatchesNode 逐条钉住 `owned_by` 的解析规则。
//
// 这张表是 Node `inferModelOwnerFromId` / `inferModelOwnerFromProvider` 的投影。
// 分支顺序也有意义（`opencode-go/` 必须先于 `opencode/`，`opencode/` 必须先于
// `opencode-`），所以每条顺序敏感的前缀都单独列了一行。
func TestResolveModelOwnerMatchesNode(t *testing.T) {
	t.Parallel()

	tests := []struct {
		providerID string
		modelID    string
		want       string
	}{
		// 模型 ID 前缀优先。
		{"codex", "claude-opus-5", "anthropic"},
		{"claude", "anthropic.claude-opus-5", "anthropic"},
		{"codex", "gpt-5.5", "openai"},
		{"codex", "o4-mini", "openai"},
		{"claude", "gemini-3.5-flash", "google"},
		{"claude", "google-vertex/whatever", "google"},
		{"codex", "kimi-k2", "moonshotai"},
		{"codex", "k3", "moonshotai"},
		{"claude", "glm-5", "zhipu"},
		{"claude", "opencode-go/gpt-5.5", "opencode-go"},
		{"claude", "opencode/gpt-5.5", "opencode-zen"},
		{"claude", "opencode-thing", "opencode"},
		// 大小写不敏感（相对 Node 的 `startsWith` 是刻意放宽，方向是多认出来）。
		{"codex", "Claude-Opus-5", "anthropic"},
		// 模型名认不出来时按 Provider 推断。
		{"claude", "shared-model", "anthropic"},
		{"codex", "shared-model", "openai"},
		{"gemini", "shared-model", "google"},
		{"opencode", "shared-model", "opencode"},
		{"kimi", "shared-model", "moonshotai"},
		{"zcode", "shared-model", "zhipu"},
		// 聚合 Provider + 认不出的模型名 → 兜底，而不是猜一个厂商。
		{"agy", "unknown-thing", "aih-server"},
		{"qoder", "unknown-thing", "aih-server"},
		{"kiro", "unknown-thing", "aih-server"},
		{"codebuddy", "unknown-thing", "aih-server"},
		// 单站 Provider 仍然优先按模型名判。
		{"codex", "unknown-thing", "openai"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.providerID+"/"+test.modelID, func(t *testing.T) {
			t.Parallel()
			got := resolveModelOwner(test.providerID, test.modelID)
			if got != test.want {
				t.Fatalf(
					"resolveModelOwner(%q, %q) = %q, want %q",
					test.providerID,
					test.modelID,
					got,
					test.want,
				)
			}
		})
	}
}
