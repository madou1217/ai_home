package inference

import (
	"bytes"
	"errors"
	"testing"
)

// TestToolValuesRequireExactIdentifiersAndJSONObject 验证工具定义、调用和结果必须保留
// 明确标识，并拒绝用空对象替代非法 JSON。
func TestToolValuesRequireExactIdentifiersAndJSONObject(t *testing.T) {
	t.Parallel()

	schema := []byte(`{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}`)
	tool, err := NewToolDefinition("lookup", "查询账号", schema)
	if err != nil {
		t.Fatalf("NewToolDefinition() error = %v", err)
	}
	call, err := NewToolCallContent("call_exact_1", "lookup", []byte(`{"query":"codex"}`))
	if err != nil {
		t.Fatalf("NewToolCallContent() error = %v", err)
	}
	resultText, err := NewTextContent("可用")
	if err != nil {
		t.Fatalf("NewTextContent() error = %v", err)
	}
	result, err := NewToolResultContent("call_exact_1", false, resultText)
	if err != nil {
		t.Fatalf("NewToolResultContent() error = %v", err)
	}

	if tool.Name() != "lookup" || call.CallID() != "call_exact_1" || result.CallID() != "call_exact_1" {
		t.Fatalf("tool identifiers lost: tool=%q call=%q result=%q", tool.Name(), call.CallID(), result.CallID())
	}

	invalidJSONValues := [][]byte{nil, []byte(``), []byte(`[]`), []byte(`{"query":`)}
	for _, value := range invalidJSONValues {
		if _, err := NewToolCallContent("call_exact_1", "lookup", value); !errors.Is(err, ErrInvalidJSONObject) {
			t.Fatalf("NewToolCallContent(%q) error = %v, want ErrInvalidJSONObject", value, err)
		}
	}
}

// TestToolJSONSnapshotsAreImmutable 验证 JSON Schema 和工具参数由领域值对象持有独立副本。
func TestToolJSONSnapshotsAreImmutable(t *testing.T) {
	t.Parallel()

	schema := []byte(`{"type":"object"}`)
	tool, err := NewToolDefinition("lookup", "", schema)
	if err != nil {
		t.Fatalf("NewToolDefinition() error = %v", err)
	}
	schema[0] = '['
	firstSchema := tool.InputSchema()
	firstSchema[0] = '['
	if !bytes.Equal(tool.InputSchema(), []byte(`{"type":"object"}`)) {
		t.Fatalf("ToolDefinition.InputSchema() = %s, want immutable object", tool.InputSchema())
	}

	arguments := []byte(`{"query":"codex"}`)
	call, err := NewToolCallContent("call_exact_1", "lookup", arguments)
	if err != nil {
		t.Fatalf("NewToolCallContent() error = %v", err)
	}
	arguments[0] = '['
	firstArguments := call.Arguments()
	firstArguments[0] = '['
	if !bytes.Equal(call.Arguments(), []byte(`{"query":"codex"}`)) {
		t.Fatalf("ToolCallContent.Arguments() = %s, want immutable object", call.Arguments())
	}
}

// TestToolDefinitionPreservesExplicitStrictMode 验证 Responses 工具的 strict 显式值
// 不会被 Claude 或 Codex Adapter 按默认值重新猜测。
func TestToolDefinitionPreservesExplicitStrictMode(t *testing.T) {
	t.Parallel()

	tool, err := NewToolDefinitionWithStrict("lookup", "", []byte(`{"type":"object"}`), false)
	if err != nil {
		t.Fatalf("NewToolDefinitionWithStrict() error = %v", err)
	}
	strict, specified := tool.Strict()
	if !specified || strict {
		t.Fatalf("ToolDefinition.Strict() = (%t, %t), want (false, true)", strict, specified)
	}

	defaultTool, err := NewToolDefinition("lookup", "", []byte(`{"type":"object"}`))
	if err != nil {
		t.Fatalf("NewToolDefinition() error = %v", err)
	}
	if _, specified := defaultTool.Strict(); specified {
		t.Fatal("未声明 strict 的工具不应被填充默认值")
	}
}

// TestToolDefinitionPreservesExecutionHints 验证 Claude custom tool 的调用来源、
// 延迟加载、参数流和输入示例都由 Canonical Contract 持有独立副本。
func TestToolDefinitionPreservesExecutionHints(t *testing.T) {
	t.Parallel()

	strict := true
	deferLoading := true
	eagerInputStreaming := false
	example := []byte(`{"query":"codex"}`)
	tool, err := NewToolDefinitionWithOptions(
		"lookup",
		"查询账号",
		[]byte(`{"type":"object"}`),
		ToolDefinitionOptions{
			Strict:              &strict,
			AllowedCallers:      []ToolCaller{ToolCallerDirect, ToolCallerCodeExecution20260120},
			DeferLoading:        &deferLoading,
			EagerInputStreaming: &eagerInputStreaming,
			InputExamples:       [][]byte{example},
		},
	)
	if err != nil {
		t.Fatalf("NewToolDefinitionWithOptions() error = %v", err)
	}
	example[0] = '['
	callers := tool.AllowedCallers()
	callers[0] = ToolCallerCodeExecution20250825
	examples := tool.InputExamples()
	examples[0][0] = '['

	gotCallers := tool.AllowedCallers()
	gotExamples := tool.InputExamples()
	if len(gotCallers) != 2 ||
		gotCallers[0] != ToolCallerDirect ||
		string(gotExamples[0]) != `{"query":"codex"}` {
		t.Fatalf("tool hints mutated: callers=%#v examples=%q", gotCallers, gotExamples)
	}
	if value, found := tool.DeferLoading(); !found || !value {
		t.Fatalf("DeferLoading() = (%t, %t), want explicit true", value, found)
	}
	if value, found := tool.EagerInputStreaming(); !found || value {
		t.Fatalf("EagerInputStreaming() = (%t, %t), want explicit false", value, found)
	}
}

// TestToolResultRejectsMissingOrRecursiveContent 验证工具结果不能缺 call ID，
// 也不能递归包含另一个工具结果来制造模糊配对。
func TestToolResultRejectsMissingOrRecursiveContent(t *testing.T) {
	t.Parallel()

	text, err := NewTextContent("第一次结果")
	if err != nil {
		t.Fatalf("NewTextContent() error = %v", err)
	}
	result, err := NewToolResultContent("call_exact_1", false, text)
	if err != nil {
		t.Fatalf("NewToolResultContent() error = %v", err)
	}
	if _, err := NewToolResultContent("", false, text); !errors.Is(err, ErrInvalidToolCallID) {
		t.Fatalf("missing call ID error = %v, want ErrInvalidToolCallID", err)
	}
	if _, err := NewToolResultContent("call_exact_2", false, result); !errors.Is(err, ErrInvalidToolResult) {
		t.Fatalf("recursive result error = %v, want ErrInvalidToolResult", err)
	}
}

// TestToolResultAllowsExplicitEmptyContent 验证缺省 content 仍保留调用 ID 和
// 错误状态，不需要伪造占位文本。
func TestToolResultAllowsExplicitEmptyContent(t *testing.T) {
	t.Parallel()

	result, err := NewToolResultContent("call_empty_1", true)
	if err != nil {
		t.Fatalf("NewToolResultContent() error = %v", err)
	}
	if result.CallID() != "call_empty_1" || !result.IsError() || len(result.Contents()) != 0 {
		t.Fatalf("result = %#v, want empty error result", result)
	}
}
