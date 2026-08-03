package messages

import (
	"encoding/json"
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

// TestEncodeRequestPreservesContextManagementAndBeta 验证 Canonical 编辑的
// 字段、声明顺序和 context-management Beta Header 无损进入 Claude 请求。
func TestEncodeRequestPreservesContextManagementAndBeta(t *testing.T) {
	t.Parallel()

	retention, err := inference.NewRecentThinkingRetention(1)
	if err != nil {
		t.Fatalf("NewRecentThinkingRetention() error = %v", err)
	}
	thinkingEdit, err := inference.NewClearThinkingEdit(&retention)
	if err != nil {
		t.Fatalf("NewClearThinkingEdit() error = %v", err)
	}
	trigger := mustContextMetric(t, inference.ContextMetricInputTokens, 180000)
	clearAtLeast := mustContextMetric(t, inference.ContextMetricInputTokens, 140000)
	clearInputs, err := inference.NewNamedToolInputClear([]string{"Read", "Grep"})
	if err != nil {
		t.Fatalf("NewNamedToolInputClear() error = %v", err)
	}
	toolEdit, err := inference.NewClearToolUsesEdit(inference.ClearToolUsesInput{
		Trigger:         &trigger,
		ClearAtLeast:    &clearAtLeast,
		ClearToolInputs: &clearInputs,
		ExcludeTools:    []string{"Edit"},
	})
	if err != nil {
		t.Fatalf("NewClearToolUsesEdit() error = %v", err)
	}
	management, err := inference.NewContextManagement(thinkingEdit, toolEdit)
	if err != nil {
		t.Fatalf("NewContextManagement() error = %v", err)
	}
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol:    inference.ClientProtocolAnthropicMessages,
		Model:             "claude-sonnet-5",
		Messages:          []inference.Message{mustMessage(t, inference.RoleUser, mustText(t, "hello"))},
		ContextManagement: &management,
	})
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}

	encoded, err := encodeRequest(request, "claude-sonnet-5")
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}
	if !containsBeta(encoded.betaHeaders, betaContextManagement) {
		t.Fatalf("betaHeaders = %v", encoded.betaHeaders)
	}
	var payload struct {
		ContextManagement struct {
			Edits []map[string]any `json:"edits"`
		} `json:"context_management"`
	}
	if err := json.Unmarshal(encoded.payload, &payload); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	edits := payload.ContextManagement.Edits
	if len(edits) != 2 ||
		edits[0]["type"] != clearThinkingType ||
		edits[0]["keep"].(map[string]any)["type"] != "thinking_turns" ||
		edits[0]["keep"].(map[string]any)["value"] != float64(1) ||
		edits[1]["type"] != clearToolUsesType ||
		edits[1]["trigger"].(map[string]any)["value"] != float64(180000) ||
		edits[1]["clear_at_least"].(map[string]any)["value"] != float64(140000) ||
		len(edits[1]["clear_tool_inputs"].([]any)) != 2 ||
		len(edits[1]["exclude_tools"].([]any)) != 1 {
		t.Fatalf("context_management = %#v", payload.ContextManagement)
	}
}

// mustContextMetric 创建 Encoder 测试使用的带单位数量。
func mustContextMetric(
	t *testing.T,
	kind inference.ContextMetricKind,
	value uint64,
) inference.ContextMetric {
	t.Helper()
	metric, err := inference.NewContextMetric(kind, value)
	if err != nil {
		t.Fatalf("NewContextMetric() error = %v", err)
	}
	return metric
}
