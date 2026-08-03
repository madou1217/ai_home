package messages

import (
	"encoding/json"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/anthropicmessages"
)

// TestAnthropicRedactedThinkingRoundTripsToClaude 验证客户端 Decoder、Canonical
// 和 Claude 上游 Encoder 共同保留 redacted_thinking 的原生类型与数据。
func TestAnthropicRedactedThinkingRoundTripsToClaude(t *testing.T) {
	t.Parallel()

	request, err := anthropicmessages.NewRequestDecoder().Decode([]byte(`{
		"model":"claude-opus-5",
		"max_tokens":1024,
		"messages":[
			{"role":"assistant","content":[
				{"type":"redacted_thinking","data":"redacted-exact-1"},
				{"type":"text","text":"历史回答"}
			]},
			{"role":"user","content":"继续"}
		]
	}`))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	encoded, err := encodeRequest(request, "claude-opus-5")
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}
	var payload struct {
		Messages []struct {
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(encoded.payload, &payload); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if len(payload.Messages) != 2 {
		t.Fatalf("messages = %#v", payload.Messages)
	}
	var contents []struct {
		Type string `json:"type"`
		Data string `json:"data"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(payload.Messages[0].Content, &contents); err != nil {
		t.Fatalf("json.Unmarshal(content) error = %v", err)
	}
	if len(contents) != 2 ||
		contents[0].Type != "redacted_thinking" ||
		contents[0].Data != "redacted-exact-1" ||
		contents[1].Type != "text" ||
		contents[1].Text != "历史回答" {
		t.Fatalf("contents = %#v", contents)
	}
}
