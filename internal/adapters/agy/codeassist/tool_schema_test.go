package codeassist

import (
	"encoding/json"
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

// TestNormalizeToolSchemaMatchesNodeCodeAssistShape 与 Node gemini-schema + code-assist-tool-schema 对齐：
// 去 $ 前缀与非白名单键、非字符串 enum 整条丢弃、Claude 目标折叠 anyOf、根保证为 object。
func TestNormalizeToolSchemaMatchesNodeCodeAssistShape(t *testing.T) {
	t.Parallel()

	var schema map[string]any
	if err := json.Unmarshal([]byte(`{
		"$schema": "https://json-schema.org/draft/2020-12/schema",
		"type": "object",
		"additionalProperties": false,
		"properties": {
			"status": {"anyOf": [{"type": "string", "enum": ["pending","done"]}, {"type": "string"}]},
			"level": {"type": "integer", "enum": [1, 2, 3]},
			"mode": {"type": ["string", "null"], "unknownKeyword": true},
			"value": {"anyOf": [{"type": "string"}, {"type": "number"}], "description": "free"}
		},
		"required": ["status"]
	}`), &schema); err != nil {
		t.Fatal(err)
	}
	got := normalizeToolSchema(schema, true)
	encoded, _ := json.Marshal(got)
	var round map[string]any
	_ = json.Unmarshal(encoded, &round)
	properties := round["properties"].(map[string]any)

	if _, found := round["$schema"]; found {
		t.Fatalf("$schema must be dropped: %s", encoded)
	}
	status := properties["status"].(map[string]any)
	if _, found := status["anyOf"]; found || status["type"] != "string" {
		t.Fatalf("status union not folded: %v", status)
	}
	if _, found := status["enum"]; found {
		t.Fatalf("open union must drop enum: %v", status)
	}
	if _, found := properties["level"].(map[string]any)["enum"]; found {
		t.Fatalf("non-string enum must be dropped: %v", properties["level"])
	}
	mode := properties["mode"].(map[string]any)
	if mode["type"] != "string" || mode["unknownKeyword"] != nil {
		t.Fatalf("mode = %v", mode)
	}
	value := properties["value"].(map[string]any)
	if _, found := value["type"]; found || value["description"] != "free" {
		t.Fatalf("mixed-type union must become an untyped node: %v", value)
	}

	gemini := normalizeToolSchema(map[string]any{"properties": map[string]any{"x": map[string]any{"anyOf": []any{map[string]any{"type": "string"}}}}}, false)
	if gemini["type"] != "object" {
		t.Fatalf("root type must be object: %v", gemini)
	}
	if _, found := gemini["properties"].(map[string]any)["x"].(map[string]any)["anyOf"]; !found {
		t.Fatal("Gemini targets keep anyOf")
	}
}

// TestToolNameMapperDisambiguatesNamespacedTools 防回归：Codex CLI 的 mcp__cua_repl/js 与
// mcp__node_repl/js 同名，裸名发给上游报「Tool names must be unique」。
func TestToolNameMapperDisambiguatesNamespacedTools(t *testing.T) {
	t.Parallel()

	plain, _ := inference.NewToolIdentity("exec_command")
	cuaJS, _ := inference.NewNamespacedToolIdentity("mcp__cua_repl", "js")
	nodeJS, _ := inference.NewNamespacedToolIdentity("mcp__node_repl", "js")
	mapper := toolNameMapper{toWire: map[inference.ToolIdentity]string{}, fromWire: map[string]inference.ToolIdentity{}}
	for _, identity := range []inference.ToolIdentity{plain, cuaJS, nodeJS} {
		wire := identity.Name()
		if namespace, ok := identity.Namespace(); ok {
			wire = namespace + "__" + identity.Name()
		}
		if err := mapper.bind(identity, wire); err != nil {
			t.Fatalf("bind(%v) error = %v", identity, err)
		}
	}
	for _, identity := range []inference.ToolIdentity{plain, cuaJS, nodeJS} {
		wire, err := mapper.encode(identity)
		if err != nil {
			t.Fatal(err)
		}
		back, err := mapper.decode(wire)
		if err != nil || back != identity {
			t.Fatalf("round trip %v -> %q -> %v (%v)", identity, wire, back, err)
		}
	}
	if long := hashedToolName(cuaJS); len(long) > maxCodeAssistToolNameBytes {
		t.Fatalf("hashed name too long: %q", long)
	}
}
