package anthropicmessages

import (
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

// TestRequestDecoderPreservesMidConversationSystemRole 验证 Beta Messages
// 的 system 消息保持原始位置，不会被降级为 user 或错误提升到请求头部。
func TestRequestDecoderPreservesMidConversationSystemRole(t *testing.T) {
	t.Parallel()

	request, err := NewRequestDecoder().Decode([]byte(`{
		"model":"claude-sonnet-5",
		"max_tokens":4096,
		"system":"global",
		"messages":[
			{"role":"user","content":"first"},
			{"role":"system","content":[{"type":"text","text":"mid"}]},
			{"role":"user","content":"second"}
		]
	}`))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	messages := request.Messages()
	wantRoles := []inference.Role{
		inference.RoleSystem,
		inference.RoleUser,
		inference.RoleSystem,
		inference.RoleUser,
	}
	if len(messages) != len(wantRoles) {
		t.Fatalf("len(Messages()) = %d, want %d", len(messages), len(wantRoles))
	}
	for index, role := range wantRoles {
		if messages[index].Role() != role {
			t.Fatalf("Messages()[%d].Role() = %q, want %q", index, messages[index].Role(), role)
		}
	}
}
