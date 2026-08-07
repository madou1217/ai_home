package messages

import (
	"encoding/json"
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

// TestEncodeRequestPreservesMidConversationSystemRole 验证前置 system 进入
// 顶层参数，而会话中的 system 保持消息位置并声明 Claude Code Beta。
func TestEncodeRequestPreservesMidConversationSystemRole(t *testing.T) {
	t.Parallel()

	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolAnthropicMessages,
		Model:          "claude-sonnet-5",
		Messages: []inference.Message{
			mustMessage(t, inference.RoleSystem, mustText(t, "global")),
			mustMessage(t, inference.RoleUser, mustText(t, "first")),
			mustMessage(t, inference.RoleSystem, mustText(t, "mid")),
			mustMessage(t, inference.RoleUser, mustText(t, "second")),
		},
	})
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	encoded, err := encodeRequest(request, "claude-sonnet-5", false)
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}
	if !containsBeta(encoded.betaHeaders, betaClaudeCode) {
		t.Fatalf("betaHeaders = %v", encoded.betaHeaders)
	}
	var payload struct {
		System   []contentDTO `json:"system"`
		Messages []messageDTO `json:"messages"`
	}
	if err := json.Unmarshal(encoded.payload, &payload); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if len(payload.System) != 1 || payload.System[0].Text != "global" ||
		len(payload.Messages) != 3 ||
		payload.Messages[0].Role != "user" ||
		payload.Messages[1].Role != "system" ||
		payload.Messages[1].Content[0].Text != "mid" ||
		payload.Messages[2].Role != "user" {
		t.Fatalf("system=%#v messages=%#v", payload.System, payload.Messages)
	}
}
