package messages

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/anthropicmessages"
)

// Claude Code 2.1.289 对话中途的工具增删（本机抓到的形状）：经 Canonical 解码、Claude 编码后
// 仍在原 system 消息里，带同一个 beta。
const midConversationToolChanges = `{
	"model":"claude-opus-5-5","max_tokens":1024,
	"tools":[{"name":"Read","description":"read","input_schema":{"type":"object","properties":{"path":{"type":"string"}}}}],
	"messages":[
		{"role":"user","content":"hi"},
		{"role":"system","content":[
			{"type":"text","text":"tools changed"},
			{"type":"tool_addition","tool":{"type":"tool_definition","definition":{"name":"WebFetch","description":"fetch","input_schema":{"type":"object","properties":{"url":{"type":"string"}}}}}},
			{"type":"tool_removal","tool":{"type":"tool_reference","name":"Bash"}}
		]},
		{"role":"user","content":"go"}
	]
}`

func TestToolChangesSurviveTheCanonicalRoundTripToClaude(t *testing.T) {
	t.Parallel()
	request, err := anthropicmessages.NewRequestDecoder().Decode([]byte(midConversationToolChanges))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	encoded, err := encodeRequest(request, "claude-opus-5-5", false)
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}
	if !containsBeta(encoded.betaHeaders, betaMidConvToolChanges) {
		t.Fatalf("betas = %v", encoded.betaHeaders)
	}
	var payload struct {
		Tools    []map[string]any `json:"tools"`
		Messages []struct {
			Role    string           `json:"role"`
			Content []map[string]any `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(encoded.payload, &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Tools) != 1 || payload.Tools[0]["name"] != "Read" {
		t.Fatalf("top-level tools must stay as sent: %v", payload.Tools)
	}
	system := payload.Messages[1]
	if system.Role != "system" || len(system.Content) != 3 {
		t.Fatalf("system message = %+v", system)
	}
	addition, removal := system.Content[1], system.Content[2]
	tool, _ := addition["tool"].(map[string]any)
	definition, _ := tool["definition"].(map[string]any)
	if addition["type"] != "tool_addition" || tool["type"] != "tool_definition" || definition["name"] != "WebFetch" || definition["input_schema"] == nil {
		t.Fatalf("addition = %v", addition)
	}
	reference, _ := removal["tool"].(map[string]any)
	if removal["type"] != "tool_removal" || reference["type"] != "tool_reference" || reference["name"] != "Bash" {
		t.Fatalf("removal = %v", removal)
	}
}

func TestToolChangeDecodingRejectsWhatCanonicalCannotCarry(t *testing.T) {
	t.Parallel()
	for name, testCase := range map[string]struct{ block, role, field string }{
		"user role":     {`{"type":"tool_removal","tool":{"type":"tool_reference","name":"Bash"}}`, "user", "messages[1].content[0]"},
		"server tool":   {`{"type":"tool_addition","tool":{"type":"tool_definition","definition":{"type":"web_search_20250305","name":"web_search"}}}`, "system", "type=web_search_20250305"},
		"unknown ref":   {`{"type":"tool_removal","tool":{"type":"tool_id","id":"x"}}`, "system", "tool.id(unknown)"},
		"unknown field": {`{"type":"tool_removal","tool":{"type":"tool_reference","name":"Bash"},"extra":1}`, "system", "extra(unknown)"},
	} {
		t.Run(name, func(t *testing.T) {
			body := `{"model":"m","max_tokens":8,"messages":[{"role":"user","content":"a"},{"role":"` + testCase.role + `","content":[` + testCase.block + `]}]}`
			_, err := anthropicmessages.NewRequestDecoder().Decode([]byte(body))
			if err == nil || !strings.Contains(err.Error(), testCase.field) {
				t.Fatalf("Decode() error = %v, want %s", err, testCase.field)
			}
		})
	}
}

// 工具搜索开启时 Claude Code 先在顶层 tools 里声明 defer_loading 的工具，命中后用 tool_reference
// 按名启用（线上 Go 曾以 tool.name(unknown) 拒收、交回 Node）。
func TestToolAdditionByReferenceSurvivesTheCanonicalRoundTripToClaude(t *testing.T) {
	t.Parallel()
	body := `{
		"model":"claude-opus-5-5","max_tokens":1024,
		"tools":[
			{"name":"Read","description":"read","input_schema":{"type":"object"}},
			{"name":"WebFetch","description":"fetch","input_schema":{"type":"object"},"defer_loading":true}
		],
		"messages":[
			{"role":"user","content":"hi"},
			{"role":"system","content":[{"type":"tool_addition","tool":{"type":"tool_reference","name":"WebFetch"}}]},
			{"role":"user","content":"go"}
		]
	}`
	request, err := anthropicmessages.NewRequestDecoder().Decode([]byte(body))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	encoded, err := encodeRequest(request, "claude-opus-5-5", false)
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}
	if !containsBeta(encoded.betaHeaders, betaMidConvToolChanges) {
		t.Fatalf("betas = %v", encoded.betaHeaders)
	}
	var payload struct {
		Tools    []map[string]any `json:"tools"`
		Messages []struct {
			Content []map[string]any `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(encoded.payload, &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Tools) != 2 || payload.Tools[1]["defer_loading"] != true {
		t.Fatalf("deferred tool must stay declared: %v", payload.Tools)
	}
	addition := payload.Messages[1].Content[0]
	reference, _ := addition["tool"].(map[string]any)
	if addition["type"] != "tool_addition" || reference["type"] != "tool_reference" || reference["name"] != "WebFetch" || len(reference) != 2 {
		t.Fatalf("addition = %v", addition)
	}
}
