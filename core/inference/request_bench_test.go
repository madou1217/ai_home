package inference

import "testing"

// BenchmarkCapabilitySetContainsAll 测量账号征召热路径的能力位图覆盖判断。
func BenchmarkCapabilitySetContainsAll(b *testing.B) {
	candidate := CapabilitySet(0).
		with(CapabilityTextGeneration).
		with(CapabilityImageInput).
		with(CapabilityDocumentInput).
		with(CapabilityTools).
		with(CapabilityReasoning).
		with(CapabilityStructuredOutput).
		with(CapabilityStreaming)
	required := CapabilitySet(0).
		with(CapabilityTextGeneration).
		with(CapabilityTools).
		with(CapabilityStreaming)

	b.ReportAllocs()
	for range b.N {
		if !candidate.ContainsAll(required) {
			b.Fatal("candidate 必须覆盖 required")
		}
	}
}

// BenchmarkNewRequest 测量包含工具和 reasoning 的 Canonical Request 构造成本。
func BenchmarkNewRequest(b *testing.B) {
	text, err := NewTextContent("分析当前账号并返回结构化状态")
	if err != nil {
		b.Fatalf("NewTextContent() error = %v", err)
	}
	message, err := NewMessage(RoleUser, text)
	if err != nil {
		b.Fatalf("NewMessage() error = %v", err)
	}
	tool, err := NewToolDefinition("lookup", "查询账号", []byte(`{"type":"object"}`))
	if err != nil {
		b.Fatalf("NewToolDefinition() error = %v", err)
	}
	reasoning, err := NewEffortReasoning(ReasoningEffortHigh, ReasoningSummaryAuto)
	if err != nil {
		b.Fatalf("NewEffortReasoning() error = %v", err)
	}
	input := RequestInput{
		ClientProtocol: ClientProtocolOpenAIResponses,
		Model:          "gpt-5.6-sol",
		Messages:       []Message{message},
		Tools:          []ToolDefinition{tool},
		Reasoning:      &reasoning,
		Stream:         true,
	}

	b.ReportAllocs()
	for range b.N {
		if _, err := NewRequest(input); err != nil {
			b.Fatalf("NewRequest() error = %v", err)
		}
	}
}
