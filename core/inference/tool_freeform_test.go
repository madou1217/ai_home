package inference

import (
	"errors"
	"testing"
)

// TestFreeformToolDefinitionKeepsFormatAndSharedSchema 验证 freeform 工具保留语法并
// 暴露统一的 {"input":string} Schema，供不支持 freeform 的 Provider 当普通工具执行。
func TestFreeformToolDefinitionKeepsFormatAndSharedSchema(t *testing.T) {
	t.Parallel()

	format, err := NewGrammarFreeformFormat("lark", "start: SOURCE\nSOURCE: /[\\s\\S]+/\n")
	if err != nil {
		t.Fatalf("NewGrammarFreeformFormat() error = %v", err)
	}
	tool, err := NewFreeformToolDefinition("functions", "", "exec", "Run JavaScript", format)
	if err != nil {
		t.Fatalf("NewFreeformToolDefinition() error = %v", err)
	}
	got, freeform := tool.Freeform()
	syntax, definition, grammar := got.Grammar()
	if !freeform || !grammar || syntax != "lark" || definition == "" || !tool.IsValid() {
		t.Fatalf("freeform = %v grammar = %v syntax = %q valid = %v", freeform, grammar, syntax, tool.IsValid())
	}
	if namespace, ok := tool.Namespace(); !ok || namespace != "functions" {
		t.Fatalf("namespace = %q %v", namespace, ok)
	}
	if !isFreeformInputSchema(tool.InputSchema()) {
		t.Fatalf("schema = %s", tool.InputSchema())
	}
	cloned := tool.clone()
	if _, ok := cloned.Freeform(); !ok {
		t.Fatal("clone dropped freeform format")
	}

	plain, err := NewToolDefinition("lookup", "", []byte(`{"type":"object"}`))
	if err != nil {
		t.Fatalf("NewToolDefinition() error = %v", err)
	}
	if _, ok := plain.Freeform(); ok {
		t.Fatal("plain tool reported freeform")
	}
	if _, err := NewToolDefinitionWithOptions("x", "", []byte(`{"type":"object"}`), ToolDefinitionOptions{
		Freeform: &format,
	}); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("freeform with foreign schema error = %v", err)
	}
	if _, err := NewGrammarFreeformFormat("ebnf", "x"); err == nil {
		t.Fatal("unknown grammar syntax accepted")
	}
	if !NewTextFreeformFormat().IsValid() {
		t.Fatal("text format invalid")
	}
}

// TestFreeformArgumentsRoundTripExactly 验证原始字符串（含换行与引号）往返无损，
// 非恰好一个字符串 input 的对象失败关闭。
func TestFreeformArgumentsRoundTripExactly(t *testing.T) {
	t.Parallel()

	input := "*** Begin Patch\n*** Add File: \"a.txt\"\n+hi\n*** End Patch"
	arguments, err := FreeformToolArguments(input)
	if err != nil {
		t.Fatalf("FreeformToolArguments() error = %v", err)
	}
	if !isJSONObject(arguments) {
		t.Fatalf("arguments are not a JSON object: %s", arguments)
	}
	got, err := FreeformInputFromArguments(arguments)
	if err != nil || got != input {
		t.Fatalf("round trip = %q, %v", got, err)
	}
	for _, invalid := range []string{
		`{}`,
		`{"input":1}`,
		`{"input":"a","extra":"b"}`,
		`{"cmd":"a"}`,
		`[]`,
	} {
		if _, err := FreeformInputFromArguments([]byte(invalid)); !errors.Is(err, ErrInvalidFreeformArguments) {
			t.Fatalf("FreeformInputFromArguments(%s) error = %v", invalid, err)
		}
	}
}

// TestRequestHintsAcceptOnlyKnownValues 验证 verbosity、reasoning context 与 ultra 强度。
func TestRequestHintsAcceptOnlyKnownValues(t *testing.T) {
	t.Parallel()

	text, err := NewTextContent("hi")
	if err != nil {
		t.Fatalf("NewTextContent() error = %v", err)
	}
	message, err := NewMessage(RoleUser, text)
	if err != nil {
		t.Fatalf("NewMessage() error = %v", err)
	}
	reasoning, err := NewEffortReasoning(ReasoningEffortUltra, ReasoningSummaryAuto)
	if err != nil {
		t.Fatalf("NewEffortReasoning(ultra) error = %v", err)
	}
	request, err := NewRequest(RequestInput{
		ClientProtocol:   ClientProtocolOpenAIResponses,
		Model:            "gpt-6-astra",
		Messages:         []Message{message},
		Reasoning:        &reasoning,
		TextVerbosity:    TextVerbosityLow,
		ReasoningContext: ReasoningContextAllTurns,
	})
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	if verbosity, ok := request.TextVerbosity(); !ok || verbosity != TextVerbosityLow {
		t.Fatalf("verbosity = %q %v", verbosity, ok)
	}
	if context, ok := request.ReasoningContext(); !ok || context != ReasoningContextAllTurns {
		t.Fatalf("context = %q %v", context, ok)
	}
	for _, input := range []RequestInput{
		{ClientProtocol: ClientProtocolOpenAIResponses, Model: "m", Messages: []Message{message}, TextVerbosity: "loud"},
		{ClientProtocol: ClientProtocolOpenAIResponses, Model: "m", Messages: []Message{message}, ReasoningContext: "current_turn"},
	} {
		if _, err := NewRequest(input); err == nil {
			t.Fatalf("NewRequest(%+v) accepted unknown hint", input)
		}
	}
}
