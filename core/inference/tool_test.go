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
