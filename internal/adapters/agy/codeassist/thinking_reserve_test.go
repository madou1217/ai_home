package codeassist

import "testing"

// TestWithThinkingReserveKeepsAnswerBudget 防回归：生产 Gemini canary 中 maxOutputTokens=64
// 全被默认思考吃光，答案为空（MAX_TOKENS）。Gemini 模型预留思考余量，Claude 模型不变。
func TestWithThinkingReserveKeepsAnswerBudget(t *testing.T) {
	t.Parallel()

	for _, testCase := range []struct {
		model string
		in    uint64
		want  uint64
	}{
		{model: "gemini-3-flash", in: 64, want: 64 + 8192},
		{model: "gemini-3.1-pro-high", in: 20000, want: 40000},
		{model: "gemini-3-flash", in: 60000, want: 60000 + 32768},
		{model: "gemini-3-flash", in: 0, want: 0},
		{model: "claude-opus-4-6-thinking", in: 64, want: 64},
	} {
		if got := withThinkingReserve(testCase.model, testCase.in); got != testCase.want {
			t.Fatalf("withThinkingReserve(%q, %d) = %d, want %d", testCase.model, testCase.in, got, testCase.want)
		}
	}
}
