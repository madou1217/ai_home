package anthropicmessages_test

import (
	"encoding/json"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/anthropicmessages"
)

// TestEstimateInputTokensMatchesNode 逐条固定 Node 的实际输出。
//
// 期望值由 Node 自己的实现生成：
//
//	node -e "const {createAnthropicTokenCountResponse}=require('./lib/server/anthropic-token-count'); …"
//
// 因此这组用例是两端同构的证据，而不是手算的猜测。改动估算规则必须同时更新两端。
func TestEstimateInputTokensMatchesNode(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		body   string
		tokens int
	}{
		{name: "empty object", body: `{}`, tokens: 1},
		{
			name:   "simple text message",
			body:   `{"messages":[{"role":"user","content":"hello world"}]}`,
			tokens: 8,
		},
		{name: "system string", body: `{"messages":[],"system":"hi"}`, tokens: 5},
		// Node 里空数组是真值，因此仍然计入 4 的开销。
		{name: "system empty array", body: `{"messages":[],"system":[]}`, tokens: 4},
		{name: "system null", body: `{"messages":[],"system":null}`, tokens: 1},
		{name: "system empty string", body: `{"messages":[],"system":""}`, tokens: 1},
		{
			name: "two messages",
			body: `{"messages":[{"role":"user","content":"a"},` +
				`{"role":"assistant","content":"bb"}]}`,
			tokens: 14,
		},
		{
			name: "text plus image block",
			body: `{"messages":[{"role":"user","content":[` +
				`{"type":"text","text":"hello"},{"type":"image","source":{}}]}]}`,
			tokens: 92,
		},
		{
			name: "tool use block",
			body: `{"messages":[{"role":"assistant","content":[` +
				`{"type":"tool_use","name":"search","input":{"q":"x"}}]}]}`,
			tokens: 12,
		},
		{
			name: "tool result block",
			body: `{"messages":[{"role":"user","content":[` +
				`{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}]}`,
			tokens: 8,
		},
		{
			name: "tools array",
			body: `{"messages":[{"role":"user","content":"q"}],"tools":[` +
				`{"name":"search","description":"d","input_schema":{"type":"object"}}]}`,
			tokens: 28,
		},
		{
			name:   "tool choice object",
			body:   `{"messages":[{"role":"user","content":"q"}],"tool_choice":{"type":"auto"}}`,
			tokens: 10,
		},
		{
			name:   "empty tools array",
			body:   `{"messages":[],"tools":[]}`,
			tokens: 1,
		},
		// 空白折叠：内容 `a\n\n   b\t c` 折叠成 `a b c`（5 字节）→ 2。
		{
			name:   "whitespace collapsing",
			body:   `{"messages":[{"role":"user","content":"a\n\n   b\t c"}]}`,
			tokens: 7,
		},
		{
			name: "unknown block type falls back to json estimate",
			body: `{"messages":[{"role":"user","content":[` +
				`{"type":"weird","x":1}]}]}`,
			tokens: 11,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			got := anthropicmessages.EstimateInputTokens([]byte(test.body))
			if got.InputTokens != test.tokens {
				t.Fatalf(
					"EstimateInputTokens() = %d, want %d (body=%s)",
					got.InputTokens,
					test.tokens,
					test.body,
				)
			}
		})
	}
}

// TestEstimateInputTokensIsIndependentOfFormatting 验证重排格式不改变估算。
//
// Node 对 JSON 子树先解析再紧凑重排，因此原始缩进与键顺序都不应影响结果。
func TestEstimateInputTokensIsIndependentOfFormatting(t *testing.T) {
	t.Parallel()

	compact := `{"messages":[{"role":"user","content":"q"}],` +
		`"tools":[{"name":"search","input_schema":{"type":"object"}}]}`
	pretty := "{\n  \"messages\": [\n    {\"role\": \"user\", \"content\": \"q\"}\n  ],\n" +
		"  \"tools\": [\n    {\"input_schema\": {\"type\": \"object\"}, \"name\": \"search\"}\n  ]\n}"

	if got, want := anthropicmessages.EstimateInputTokens([]byte(pretty)).InputTokens,
		anthropicmessages.EstimateInputTokens([]byte(compact)).InputTokens; got != want {
		t.Fatalf("pretty=%d compact=%d, want equal", got, want)
	}
}

// TestEstimateInputTokensHandlesMalformedBody 验证不可解析正文按空请求兜底。
func TestEstimateInputTokensHandlesMalformedBody(t *testing.T) {
	t.Parallel()

	for _, body := range []string{"", "   ", "null", "[]", `"text"`, "{not json"} {
		if got := anthropicmessages.EstimateInputTokens([]byte(body)).InputTokens; got != 1 {
			t.Fatalf("body %q → %d, want 1", body, got)
		}
	}
}

// TestTokenCountResponseMarshalsAnthropicShape 验证响应只暴露 input_tokens。
func TestTokenCountResponseMarshalsAnthropicShape(t *testing.T) {
	t.Parallel()

	encoded, err := json.Marshal(anthropicmessages.EstimateInputTokens(
		[]byte(`{"messages":[{"role":"user","content":"hello world"}]}`),
	))
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	if got, want := string(encoded), `{"input_tokens":8}`; got != want {
		t.Fatalf("marshalled response = %s, want %s", got, want)
	}
}
