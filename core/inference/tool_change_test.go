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

func TestToolAdditionByReferenceFoldsAwayWithoutTouchingTools(t *testing.T) {
	if _, err := NewToolAdditionByReference(" "); err == nil {
		t.Fatal("a reference addition needs a name")
	}
	addition, err := NewToolAdditionByReference("WebFetch")
	if err != nil || !addition.IsValid() || addition.Change() != ToolChangeAddition {
		t.Fatalf("addition = %+v, err = %v", addition, err)
	}
	if _, byValue := addition.Definition(); byValue || addition.ReferencedName() != "WebFetch" || addition.RemovedName() != "" {
		t.Fatal("a reference addition carries only the referenced name")
	}
	deferred := true
	tool, _ := NewToolDefinitionWithOptions("WebFetch", "fetch", []byte(`{"type":"object"}`), ToolDefinitionOptions{DeferLoading: &deferred})
	text, _ := NewTextContent("hi")
	user, _ := NewMessage(RoleUser, text)
	system, err := NewMessage(RoleSystem, addition)
	if err != nil {
		t.Fatal(err)
	}
	request, err := NewRequest(RequestInput{
		ClientProtocol: ClientProtocolAnthropicMessages, Model: "m",
		Messages: []Message{user, system, user},
		Tools:    []ToolDefinition{tool},
	})
	if err != nil {
		t.Fatal(err)
	}
	folded := request.FoldToolChanges()
	if folded.HasToolChanges() || len(folded.Tools()) != 1 || len(folded.Messages()) != 2 {
		t.Fatalf("folded: changes=%v tools=%d messages=%d", folded.HasToolChanges(), len(folded.Tools()), len(folded.Messages()))
	}
}
