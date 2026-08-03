package anthropicmessages

import (
	"errors"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

// TestRequestDecoderPreservesClaudeCodeContextManagement 验证 Claude Code
// 当前发送的两种编辑及全部字段进入 Canonical Request。
func TestRequestDecoderPreservesClaudeCodeContextManagement(t *testing.T) {
	t.Parallel()

	request, err := NewRequestDecoder().Decode([]byte(`{
		"model":"claude-sonnet-5",
		"max_tokens":4096,
		"messages":[{"role":"user","content":"hello"}],
		"context_management":{"edits":[
			{"type":"clear_thinking_20251015","keep":"all"},
			{
				"type":"clear_tool_uses_20250919",
				"trigger":{"type":"input_tokens","value":180000},
				"keep":{"type":"tool_uses","value":5},
				"clear_at_least":{"type":"input_tokens","value":140000},
				"clear_tool_inputs":["Read","Grep"],
				"exclude_tools":["Edit"]
			}
		]}
	}`))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	management, found := request.ContextManagement()
	if !found || !request.RequiredCapabilities().Has(
		inference.CapabilityContextManagement,
	) {
		t.Fatalf("ContextManagement() found=%t capabilities=%032b", found, request.RequiredCapabilities())
	}
	edits := management.Edits()
	if len(edits) != 2 ||
		edits[0].Kind() != inference.ContextEditClearThinking ||
		edits[1].Kind() != inference.ContextEditClearToolUses {
		t.Fatalf("edits = %#v", edits)
	}
	retention, found := edits[0].ThinkingRetention()
	if !found || retention.Mode() != inference.ThinkingRetentionAll {
		t.Fatalf("ThinkingRetention() = (%#v, %t)", retention, found)
	}
	trigger, found := edits[1].Trigger()
	if !found ||
		trigger.Kind() != inference.ContextMetricInputTokens ||
		trigger.Value() != 180000 {
		t.Fatalf("Trigger() = (%#v, %t)", trigger, found)
	}
	keep, found := edits[1].Keep()
	if !found ||
		keep.Kind() != inference.ContextMetricToolUses ||
		keep.Value() != 5 {
		t.Fatalf("Keep() = (%#v, %t)", keep, found)
	}
	clearInputs, found := edits[1].ClearToolInputs()
	if !found ||
		clearInputs.Mode() != inference.ToolInputClearNamed ||
		strings.Join(clearInputs.Tools(), ",") != "Read,Grep" ||
		strings.Join(edits[1].ExcludeTools(), ",") != "Edit" {
		t.Fatalf(
			"clearInputs=(%#v,%t) exclude=%v",
			clearInputs,
			found,
			edits[1].ExcludeTools(),
		)
	}
}

// TestRequestDecoderAcceptsOfficialAllThinkingObject 验证官方 SDK 的
// {type:"all"} 与 Claude Code 的 "all" 收敛为同一 Canonical 语义。
func TestRequestDecoderAcceptsOfficialAllThinkingObject(t *testing.T) {
	t.Parallel()

	request, err := NewRequestDecoder().Decode([]byte(`{
		"model":"claude-sonnet-5",
		"max_tokens":4096,
		"messages":[{"role":"user","content":"hello"}],
		"context_management":{"edits":[{
			"type":"clear_thinking_20251015",
			"keep":{"type":"all"}
		}]}
	}`))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	management, found := request.ContextManagement()
	if !found {
		t.Fatal("ContextManagement() found = false")
	}
	retention, found := management.Edits()[0].ThinkingRetention()
	if !found || retention.Mode() != inference.ThinkingRetentionAll {
		t.Fatalf("ThinkingRetention() = (%#v, %t)", retention, found)
	}
}

// TestRequestDecoderRejectsUnsafeContextManagementShapes 验证未知版本和
// 未知嵌套字段不会被静默丢弃，错误也只暴露字段路径。
func TestRequestDecoderRejectsUnsafeContextManagementShapes(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		edit      string
		wantKind  error
		wantField string
	}{
		{
			name:      "unknown edit version",
			edit:      `{"type":"compact_20260112"}`,
			wantKind:  ErrUnsupportedFeature,
			wantField: "context_management.edits[0].type",
		},
		{
			name:      "unknown nested field",
			edit:      `{"type":"clear_thinking_20251015","keep":"all","secret":"not-returned"}`,
			wantKind:  ErrInvalidMessagesRequest,
			wantField: "context_management.edits[0]",
		},
		{
			name:      "metric unit mismatch",
			edit:      `{"type":"clear_tool_uses_20250919","keep":{"type":"input_tokens","value":5}}`,
			wantKind:  ErrInvalidMessagesRequest,
			wantField: "context_management.edits[0].keep.type",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			body := `{"model":"claude-sonnet-5","max_tokens":4096,` +
				`"messages":[{"role":"user","content":"hello"}],` +
				`"context_management":{"edits":[` + test.edit + `]}}`
			_, err := NewRequestDecoder().Decode([]byte(body))
			if !errors.Is(err, test.wantKind) ||
				err == nil ||
				!strings.Contains(err.Error(), test.wantField) ||
				strings.Contains(err.Error(), "not-returned") {
				t.Fatalf("Decode() error = %v", err)
			}
		})
	}
}
