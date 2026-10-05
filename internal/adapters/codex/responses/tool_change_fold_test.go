package responses

import (
	"strings"
	"testing"

	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/anthropicmessages"
)

// Codex 没有对话中途的工具增删：新增的工具并入请求级 tools，增删块不出现在 input 里。
func TestCodexFoldsMidConversationToolChangesIntoTools(t *testing.T) {
	t.Parallel()
	request, err := anthropicmessages.NewRequestDecoder().Decode([]byte(`{
		"model":"gpt-6-astra","max_tokens":64,
		"tools":[{"name":"Read","description":"read","input_schema":{"type":"object"}}],
		"messages":[
			{"role":"user","content":"hi"},
			{"role":"system","content":[{"type":"tool_addition","tool":{"type":"tool_definition","definition":{"name":"WebFetch","description":"fetch","input_schema":{"type":"object"}}}}]},
			{"role":"user","content":"go"}
		]
	}`))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	payload, err := encodeRequest(request, "gpt-6-astra", codexauth.AuthKindAPIKey, requestProfileForModel("gpt-6-astra"))
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}
	if strings.Contains(string(payload), "tool_addition") {
		t.Fatalf("tool changes must not reach the codex wire: %s", payload)
	}
	// 工具的位置取决于模型档位（顶层 tools 或 input 里的 additional_tools），只核对两者都在。
	for _, name := range []string{`"name":"Read"`, `"name":"WebFetch"`} {
		if !strings.Contains(string(payload), name) {
			t.Fatalf("missing %s in %s", name, payload)
		}
	}
}
