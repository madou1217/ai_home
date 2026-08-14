package codeassist

import (
	"encoding/json"
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

func TestEncodeRequestPreservesToolCallAndResultIdentity(t *testing.T) {
	t.Parallel()

	request := toolRoundTripRequest(t)
	encoded, err := encodeRequest(request, "claude-opus-4-6-thinking", "project-1", "session-1", "agent/1/abcd")
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}
	var document map[string]any
	if err := json.Unmarshal(encoded, &document); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if document["project"] != "project-1" ||
		document["requestId"] != "agent/1/abcd" ||
		document["model"] != "claude-opus-4-6-thinking" ||
		document["userAgent"] != "antigravity" ||
		document["requestType"] != "agent" {
		t.Fatalf("outer envelope = %#v", document)
	}
	creditTypes, valid := document["enabledCreditTypes"].([]any)
	if !valid || len(creditTypes) != 1 || creditTypes[0] != "GOOGLE_ONE_AI" {
		t.Fatalf("enabledCreditTypes = %#v, want [GOOGLE_ONE_AI]", document["enabledCreditTypes"])
	}
	inner := document["request"].(map[string]any)
	if inner["sessionId"] != "session-1" {
		t.Fatalf("sessionId = %#v", inner["sessionId"])
	}
	generation := inner["generationConfig"].(map[string]any)
	if _, found := generation["thinkingConfig"]; found {
		t.Fatalf("plain request unexpectedly enabled thinking: %#v", generation)
	}
	contents := inner["contents"].([]any)
	assistantParts := contents[1].(map[string]any)["parts"].([]any)
	call := assistantParts[0].(map[string]any)["functionCall"].(map[string]any)
	if call["id"] != "call_weather_1" || call["name"] != "lookup_weather" {
		t.Fatalf("functionCall = %#v", call)
	}
	resultParts := contents[2].(map[string]any)["parts"].([]any)
	result := resultParts[0].(map[string]any)["functionResponse"].(map[string]any)
	if result["id"] != "call_weather_1" || result["name"] != "lookup_weather" {
		t.Fatalf("functionResponse = %#v", result)
	}
	tools := inner["tools"].([]any)
	declarations := tools[0].(map[string]any)["functionDeclarations"].([]any)
	declaration := declarations[0].(map[string]any)
	if declaration["name"] != "lookup_weather" || declaration["parametersJsonSchema"] == nil {
		t.Fatalf("function declaration = %#v", declaration)
	}
}

func toolRoundTripRequest(t *testing.T) inference.Request {
	t.Helper()
	userText, _ := inference.NewTextContent("weather in Shanghai")
	user, _ := inference.NewMessage(inference.RoleUser, userText)
	call, _ := inference.NewToolCallContent("call_weather_1", "lookup_weather", []byte(`{"city":"Shanghai"}`))
	assistant, _ := inference.NewMessage(inference.RoleAssistant, call)
	resultText, _ := inference.NewTextContent(`{"temperature":30}`)
	result, _ := inference.NewToolResultContent("call_weather_1", false, resultText)
	toolMessage, _ := inference.NewMessage(inference.RoleUser, result)
	tool, _ := inference.NewToolDefinition(
		"lookup_weather",
		"Look up weather",
		[]byte(`{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}`),
	)
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol:  inference.ClientProtocolAnthropicMessages,
		Model:           "claude-opus-4-6-thinking",
		Messages:        []inference.Message{user, assistant, toolMessage},
		Tools:           []inference.ToolDefinition{tool},
		Stream:          true,
		MaxOutputTokens: 128,
	})
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	return request
}
