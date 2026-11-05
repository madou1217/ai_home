package kirorelay

import (
	"encoding/json"
	"testing"
)

func encodeToMap(t *testing.T, messages []Message, options EncodeOptions) (map[string]any, EncodedConversation) {
	t.Helper()
	encoded := EncodeConversation(messages, options)
	raw, err := json.Marshal(encoded.Body)
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	return parsed, encoded
}

func conversationState(t *testing.T, parsed map[string]any) map[string]any {
	t.Helper()
	state, ok := parsed["conversationState"].(map[string]any)
	if !ok {
		t.Fatalf("缺少 conversationState: %#v", parsed)
	}
	return state
}

func TestEncodeConversationSplitsHistoryAndCurrent(t *testing.T) {
	parsed, encoded := encodeToMap(t, []Message{
		{Role: "user", Content: "hello"},
		{Role: "assistant", Content: "hi"},
		{Role: "user", Content: "next"},
	}, EncodeOptions{ConversationID: "c1", ModelID: "claude-sonnet-4.5"})
	state := conversationState(t, parsed)
	if state["chatTriggerType"] != "MANUAL" || state["conversationId"] != "c1" {
		t.Fatalf("state = %#v", state)
	}
	history, ok := state["history"].([]any)
	if !ok || len(history) != 2 {
		t.Fatalf("history = %#v", state["history"])
	}
	first := history[0].(map[string]any)["userInputMessage"].(map[string]any)
	if first["content"] != "hello" || first["modelId"] != "claude-sonnet-4.5" || first["origin"] != "AI_EDITOR" {
		t.Fatalf("first history = %#v", first)
	}
	current := state["currentMessage"].(map[string]any)["userInputMessage"].(map[string]any)
	if current["content"] != "next" {
		t.Fatalf("current = %#v", current)
	}
	if encoded.PromptText != "hello\nhi\nnext" {
		t.Fatalf("promptText = %q", encoded.PromptText)
	}
}

func TestEncodeConversationFoldsSystemIntoFirstUser(t *testing.T) {
	parsed, _ := encodeToMap(t, []Message{
		{Role: "system", Content: "be brief"},
		{Role: "user", Content: "hello"},
	}, EncodeOptions{ConversationID: "c1"})
	state := conversationState(t, parsed)
	current := state["currentMessage"].(map[string]any)["userInputMessage"].(map[string]any)
	if current["content"] != "be brief\n\nhello" {
		t.Fatalf("system 必须折进第一个 user 轮: %#v", current["content"])
	}
}

func TestEncodeConversationAppendsContinueForAssistantTail(t *testing.T) {
	parsed, _ := encodeToMap(t, []Message{
		{Role: "user", Content: "hello"},
		{Role: "assistant", Content: "hi"},
	}, EncodeOptions{ConversationID: "c1"})
	state := conversationState(t, parsed)
	current := state["currentMessage"].(map[string]any)["userInputMessage"].(map[string]any)
	if current["content"] != defaultContinuePrompt {
		t.Fatalf("末轮是 assistant 时必须补续写指令: %#v", current["content"])
	}
	if history := state["history"].([]any); len(history) != 2 {
		t.Fatalf("history = %#v", history)
	}
}

func TestEncodeConversationEmptyMessages(t *testing.T) {
	parsed, _ := encodeToMap(t, nil, EncodeOptions{ConversationID: "c1"})
	state := conversationState(t, parsed)
	current := state["currentMessage"].(map[string]any)["userInputMessage"].(map[string]any)
	if current["content"] != defaultContinuePrompt {
		t.Fatalf("空会话必须补一条 user 轮: %#v", current)
	}
	if _, ok := state["history"]; ok {
		t.Fatal("空 history 不应写入（Node 实测首轮不带 history 最稳）")
	}
}

func TestEncodeConversationReportsDegradations(t *testing.T) {
	_, encoded := encodeToMap(t, []Message{{Role: "user", Content: "look", HasImages: true}}, EncodeOptions{ToolCount: 2})
	if len(encoded.Degradations) != 2 {
		t.Fatalf("degradations = %#v", encoded.Degradations)
	}
	if encoded.Degradations[0] != "images_unsupported" || encoded.Degradations[1] != "tools_unsupported" {
		t.Fatalf("degradations = %#v", encoded.Degradations)
	}
}
