package anthropicmessages

import "testing"

func TestEstimateInputTokensIncludesMessageName(t *testing.T) {
	got := EstimateInputTokens([]byte(`{"messages":[{"role":"user","name":"tool","content":"hi"}]}`))
	if got.InputTokens != 7 {
		t.Fatalf("input_tokens = %d, want 7", got.InputTokens)
	}
}

func TestEstimateInputTokensMatchesNodeFixtures(t *testing.T) {
	tests := []struct {
		name string
		body string
		want int
	}{
		{name: "unicode content", body: `{"messages":[{"role":"assistant","name":"工具","content":[{"type":"text","text":"  hi\nthere "}]}]}`, want: 11},
		{name: "tool result", body: `{"messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":"result"}]}]}`, want: 9},
		{name: "tool use", body: `{"messages":[{"role":"assistant","content":[{"type":"tool_use","name":"f","input":{"a":"b"}}]}]}`, want: 11},
		{name: "system tools", body: `{"system":"hi","messages":[],"tools":[{"name":"f","input_schema":{"type":"object"}}],"tool_choice":{"type":"auto"}}`, want: 25},
		{name: "unknown block", body: `{"messages":[{"role":"user","content":[{"type":"custom","x":"y"}]}]}`, want: 12},
		{name: "empty", body: `{}`, want: 1},
		{name: "invalid json", body: `not-json`, want: 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := EstimateInputTokens([]byte(tt.body)).InputTokens
			if got != tt.want {
				t.Fatalf("input_tokens = %d, want %d", got, tt.want)
			}
		})
	}
}
