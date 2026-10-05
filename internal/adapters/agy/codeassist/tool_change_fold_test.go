package codeassist

import (
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/anthropicmessages"
)

// Code Assist 没有对话中途的工具增删：新增的工具并入函数声明。
func TestCodeAssistFoldsMidConversationToolChangesIntoDeclarations(t *testing.T) {
	t.Parallel()
	request, err := anthropicmessages.NewRequestDecoder().Decode([]byte(`{
		"model":"gemini-3-flash","max_tokens":64,
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
	encoded, err := encodeRequest(request, "gemini-3-flash", "project-1", "session-1", "agent/1/abcd")
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}
	if !strings.Contains(string(encoded), `"WebFetch"`) || !strings.Contains(string(encoded), `"Read"`) || strings.Contains(string(encoded), "tool_addition") {
		t.Fatalf("encoded = %s", encoded)
	}
}
