package workspaceconnector

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/remoteconnector"
)

func TestCallTimeoutForCommandBudget(t *testing.T) {
	if got := CallTimeoutFor(remoteconnector.OperationReadFile, remoteconnector.ReadFileRequest{Path: "a"}); got != DefaultCallTimeout {
		t.Fatalf("read_file timeout = %s, want %s", got, DefaultCallTimeout)
	}
	cases := []struct {
		name      string
		timeoutMS int
		want      time.Duration
	}{
		{name: "default", timeoutMS: 0, want: remoteconnector.DefaultCommandTimeout + 15*time.Second},
		{name: "below minimum", timeoutMS: 500, want: time.Second + 15*time.Second},
		{name: "above maximum", timeoutMS: int((remoteconnector.MaxCommandTimeout + time.Minute).Milliseconds()), want: remoteconnector.MaxCommandTimeout + 15*time.Second},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			payload := remoteconnector.RunCommandRequest{Command: "true", TimeoutMS: testCase.timeoutMS}
			if got := CallTimeoutFor(remoteconnector.OperationRunCommand, payload); got != testCase.want {
				t.Fatalf("timeout = %s, want %s", got, testCase.want)
			}
		})
	}
	raw := json.RawMessage(`{"command":"true","timeoutMs":500}`)
	if got := CallTimeoutFor(remoteconnector.OperationRunCommand, raw); got != time.Second+15*time.Second {
		t.Fatalf("raw payload timeout = %s, want %s", got, time.Second+15*time.Second)
	}
}

func TestToolDefinitionsForGatesRunCommand(t *testing.T) {
	enabled := remoteconnector.Capabilities{ReadFile: true, RunCommand: true}
	if !hasToolDefinition(ToolDefinitionsFor(enabled), "run_command") {
		t.Fatal("run_command missing when the connector declares it")
	}
	disabled := remoteconnector.Capabilities{ReadFile: true}
	tools := ToolDefinitionsFor(disabled)
	if hasToolDefinition(tools, "run_command") {
		t.Fatal("run_command advertised without the capability")
	}
	if !hasToolDefinition(tools, "read_file") {
		t.Fatal("file tools must stay available without run_command")
	}
}

func TestRunCommandToolValidatesBeforeDispatch(t *testing.T) {
	hub := NewHub()
	cases := []struct {
		name string
		args map[string]any
		want string
	}{
		{name: "missing command", args: map[string]any{}, want: remoteconnector.CodeInvalidPayload},
		{name: "blank command", args: map[string]any{"command": "   "}, want: remoteconnector.CodeInvalidPayload},
		{name: "oversized command", args: map[string]any{"command": strings.Repeat("a", maxToolCommandBytes+1)}, want: remoteconnector.CodeInvalidPayload},
		{name: "no live connector", args: map[string]any{"command": "true"}, want: remoteconnector.CodeWorkspaceOffline},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			result := CallTool(context.Background(), hub, "wc-test", "run_command", testCase.args)
			if result["isError"] != true {
				t.Fatalf("isError = %v, want true", result["isError"])
			}
			if text := toolResultText(t, result); !strings.Contains(text, testCase.want) {
				t.Fatalf("error text = %q, want %s", text, testCase.want)
			}
		})
	}
}

func hasToolDefinition(tools []map[string]any, name string) bool {
	for _, tool := range tools {
		if tool["name"] == name {
			return true
		}
	}
	return false
}

func toolResultText(t *testing.T, result map[string]any) string {
	t.Helper()
	content, ok := result["content"].([]any)
	if !ok || len(content) == 0 {
		t.Fatalf("tool result has no content: %#v", result)
	}
	item, ok := content[0].(map[string]any)
	if !ok {
		t.Fatalf("tool content is not an object: %#v", content[0])
	}
	text, _ := item["text"].(string)
	return text
}
