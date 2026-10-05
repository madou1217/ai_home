package inference

import "testing"

func toolChangeFixture(t *testing.T) Request {
	t.Helper()
	text, _ := NewTextContent("hi")
	existing, err := NewToolDefinition("Read", "read a file", []byte(`{"type":"object"}`))
	if err != nil {
		t.Fatal(err)
	}
	added, _ := NewToolDefinition("WebFetch", "fetch a url", []byte(`{"type":"object"}`))
	addition, err := NewToolAddition(added)
	if err != nil {
		t.Fatal(err)
	}
	duplicate, _ := NewToolAddition(existing)
	removal, err := NewToolRemoval("Bash")
	if err != nil {
		t.Fatal(err)
	}
	note, _ := NewTextContent("tools changed")
	user, _ := NewMessage(RoleUser, text)
	changesOnly, err := NewMessage(RoleSystem, addition, duplicate, removal)
	if err != nil {
		t.Fatal(err)
	}
	mixed, _ := NewMessage(RoleSystem, note, removal)
	request, err := NewRequest(RequestInput{
		ClientProtocol: ClientProtocolAnthropicMessages, Model: "m",
		Messages: []Message{user, changesOnly, mixed, user},
		Tools:    []ToolDefinition{existing},
	})
	if err != nil {
		t.Fatal(err)
	}
	return request
}

func TestToolChangesOnlyLiveInSystemMessages(t *testing.T) {
	added, _ := NewToolDefinition("X", "", []byte(`{"type":"object"}`))
	addition, _ := NewToolAddition(added)
	if _, err := NewMessage(RoleUser, addition); err == nil {
		t.Fatal("a tool change outside a system message must be rejected")
	}
	if _, err := NewToolRemoval(" "); err == nil {
		t.Fatal("a removal needs a name")
	}
}

func TestFoldToolChangesMergesAdditionsAndDropsTheBlocks(t *testing.T) {
	request := toolChangeFixture(t)
	if !request.HasToolChanges() {
		t.Fatal("fixture must carry tool changes")
	}
	folded := request.FoldToolChanges()
	if folded.HasToolChanges() {
		t.Fatal("folded request still carries tool changes")
	}
	names := []string{}
	for _, tool := range folded.Tools() {
		names = append(names, tool.Name())
	}
	if len(names) != 2 || names[0] != "Read" || names[1] != "WebFetch" {
		t.Fatalf("tools = %v, want [Read WebFetch] (additions merged once, removals ignored)", names)
	}
	if len(folded.Messages()) != 3 {
		t.Fatalf("a message holding only tool changes must be dropped: %d messages", len(folded.Messages()))
	}
	if len(request.Tools()) != 1 || len(request.Messages()) != 4 {
		t.Fatal("folding must not mutate the original request")
	}
	if !folded.RequiredCapabilities().Has(CapabilityTools) {
		t.Fatal("capabilities are derived from the folded request")
	}
	if plain := folded.FoldToolChanges(); len(plain.Tools()) != 2 {
		t.Fatal("folding twice is a no-op")
	}
}
