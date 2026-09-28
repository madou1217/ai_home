package messages

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/openairesponses"
)

// TestEncodeRequestRunsCodex0158FreeformToolAsSingleStringTool 验证 Codex CLI 0.158 的
// freeform 工具（functions.exec）路由到 Claude 时以 {input:string} 普通工具执行，历史
// custom_tool_call 变为同名 tool_use，verbosity/context 提示被忽略而不是拒绝整个请求。
func TestEncodeRequestRunsCodex0158FreeformToolAsSingleStringTool(t *testing.T) {
	t.Parallel()

	body, err := os.ReadFile("../../clientprotocol/openairesponses/testdata/codex_0158_tool_turn.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	request, err := openairesponses.NewRequestDecoder().Decode(body)
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	encoded, err := encodeRequest(request, "claude-opus-5-5", true)
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}
	var wire struct {
		Tools []struct {
			Name        string          `json:"name"`
			InputSchema json.RawMessage `json:"input_schema"`
		} `json:"tools"`
		Messages []struct {
			Content []struct {
				Type  string          `json:"type"`
				Name  string          `json:"name"`
				Input json.RawMessage `json:"input"`
			} `json:"content"`
		} `json:"messages"`
		OutputConfig struct {
			Effort string `json:"effort"`
		} `json:"output_config"`
	}
	if err := json.Unmarshal(encoded.payload, &wire); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	execName := ""
	for _, tool := range wire.Tools {
		var schema struct {
			Properties map[string]struct {
				Type string `json:"type"`
			} `json:"properties"`
		}
		_ = json.Unmarshal(tool.InputSchema, &schema)
		if schema.Properties["input"].Type == "string" && len(schema.Properties) == 1 {
			execName = tool.Name
		}
	}
	if execName == "" {
		t.Fatalf("freeform exec tool not encoded as single-string tool: %s", encoded.payload)
	}
	var toolUse *struct {
		Type  string          `json:"type"`
		Name  string          `json:"name"`
		Input json.RawMessage `json:"input"`
	}
	for messageIndex := range wire.Messages {
		for contentIndex := range wire.Messages[messageIndex].Content {
			content := &wire.Messages[messageIndex].Content[contentIndex]
			if content.Type == "tool_use" {
				toolUse = content
			}
		}
	}
	if toolUse == nil || toolUse.Name != execName || string(toolUse.Input) != `{"input":"1+1"}` {
		t.Fatalf("tool_use = %+v (exec name %q)", toolUse, execName)
	}
	if wire.OutputConfig.Effort != "max" {
		t.Fatalf("xhigh effort = %q, want max", wire.OutputConfig.Effort)
	}
}
