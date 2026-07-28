package inference

import (
	"errors"
	"testing"
)

// TestRequestDerivesRequiredCapabilitiesInOneCanonicalPlace 验证图片、文档、工具、
// reasoning、结构化输出和真实流式需求都从 Canonical Request 统一推导。
func TestRequestDerivesRequiredCapabilitiesInOneCanonicalPlace(t *testing.T) {
	t.Parallel()

	imageSource, err := NewURLMediaSource("https://example.test/input.png", "image/png")
	if err != nil {
		t.Fatalf("NewURLMediaSource() error = %v", err)
	}
	image, err := NewImageContent(imageSource, ImageDetailAuto)
	if err != nil {
		t.Fatalf("NewImageContent() error = %v", err)
	}
	documentSource, err := NewTextMediaSource("text/plain", "协议证据")
	if err != nil {
		t.Fatalf("NewTextMediaSource() error = %v", err)
	}
	document, err := NewDocumentContent(documentSource, "证据")
	if err != nil {
		t.Fatalf("NewDocumentContent() error = %v", err)
	}
	message, err := NewMessage(RoleUser, image, document)
	if err != nil {
		t.Fatalf("NewMessage() error = %v", err)
	}
	tool, err := NewToolDefinition("lookup", "查询状态", []byte(`{"type":"object"}`))
	if err != nil {
		t.Fatalf("NewToolDefinition() error = %v", err)
	}
	reasoning, err := NewEffortReasoning(ReasoningEffortHigh, ReasoningSummaryAuto)
	if err != nil {
		t.Fatalf("NewEffortReasoning() error = %v", err)
	}
	output, err := NewStructuredOutput("account_status", "账号状态", []byte(`{"type":"object"}`), true)
	if err != nil {
		t.Fatalf("NewStructuredOutput() error = %v", err)
	}

	request, err := NewRequest(RequestInput{
		ClientProtocol:   ClientProtocolAnthropicMessages,
		Model:            "claude-opus-4-1",
		Messages:         []Message{message},
		Tools:            []ToolDefinition{tool},
		Reasoning:        &reasoning,
		StructuredOutput: &output,
		Stream:           true,
	})
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}

	required := request.RequiredCapabilities()
	expected := []Capability{
		CapabilityTextGeneration,
		CapabilityImageInput,
		CapabilityDocumentInput,
		CapabilityTools,
		CapabilityReasoning,
		CapabilityStructuredOutput,
		CapabilityStreaming,
	}
	for _, capability := range expected {
		if !required.Has(capability) {
			t.Errorf("RequiredCapabilities() missing %q", capability)
		}
	}
}

// TestCapabilitySetUsesExactSubsetMatching 验证账号征召可用常数时间位图判断，
// 不会把缺失图片或流式能力的账号加入候选集。
func TestCapabilitySetUsesExactSubsetMatching(t *testing.T) {
	t.Parallel()

	candidate := CapabilitySet(0).
		with(CapabilityTextGeneration).
		with(CapabilityImageInput).
		with(CapabilityStreaming)
	required := CapabilitySet(0).
		with(CapabilityTextGeneration).
		with(CapabilityStreaming)
	if !candidate.ContainsAll(required) {
		t.Fatal("candidate 应完整覆盖 required")
	}
	if candidate.ContainsAll(required.with(CapabilityTools)) {
		t.Fatal("缺少 tools 能力的 candidate 不应通过征召")
	}
}

// TestRequestOwnsIndependentMessagesAndTools 验证 Canonical Request 不暴露调用方持有的
// 消息和工具切片，避免 Decoder 缓冲复用导致请求内容变化。
func TestRequestOwnsIndependentMessagesAndTools(t *testing.T) {
	t.Parallel()

	text, err := NewTextContent("原始请求")
	if err != nil {
		t.Fatalf("NewTextContent() error = %v", err)
	}
	message, err := NewMessage(RoleUser, text)
	if err != nil {
		t.Fatalf("NewMessage() error = %v", err)
	}
	tool, err := NewToolDefinition("lookup", "", []byte(`{"type":"object"}`))
	if err != nil {
		t.Fatalf("NewToolDefinition() error = %v", err)
	}
	messages := []Message{message}
	tools := []ToolDefinition{tool}
	request, err := NewRequest(RequestInput{
		ClientProtocol: ClientProtocolOpenAIResponses,
		Model:          "gpt-5.6-sol",
		Messages:       messages,
		Tools:          tools,
	})
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}

	messages[0] = Message{}
	tools[0] = ToolDefinition{}
	request.Messages()[0] = Message{}
	request.Tools()[0] = ToolDefinition{}

	if !request.Messages()[0].IsValid() || request.Tools()[0].Name() != "lookup" {
		t.Fatalf("request snapshots changed: messages=%#v tools=%#v", request.Messages(), request.Tools())
	}
}

// TestRequestRejectsInvalidToolPairingWithoutGuessing 验证工具结果只通过明确 call ID
// 与历史调用配对，不允许 FIFO 或自动生成 ID。
func TestRequestRejectsInvalidToolPairingWithoutGuessing(t *testing.T) {
	t.Parallel()

	call, err := NewToolCallContent("call_exact_1", "lookup", []byte(`{"query":"codex"}`))
	if err != nil {
		t.Fatalf("NewToolCallContent() error = %v", err)
	}
	assistantMessage, err := NewMessage(RoleAssistant, call)
	if err != nil {
		t.Fatalf("NewMessage() assistant error = %v", err)
	}
	text, err := NewTextContent("结果")
	if err != nil {
		t.Fatalf("NewTextContent() error = %v", err)
	}
	result, err := NewToolResultContent("call_other_2", false, text)
	if err != nil {
		t.Fatalf("NewToolResultContent() error = %v", err)
	}
	userMessage, err := NewMessage(RoleUser, result)
	if err != nil {
		t.Fatalf("NewMessage() user error = %v", err)
	}

	_, err = NewRequest(RequestInput{
		ClientProtocol: ClientProtocolAnthropicMessages,
		Model:          "claude-opus-4-1",
		Messages:       []Message{assistantMessage, userMessage},
	})
	if !errors.Is(err, ErrUnmatchedToolResult) {
		t.Fatalf("NewRequest() error = %v, want ErrUnmatchedToolResult", err)
	}
}

// TestRequestPreservesWhitespaceStopSequence 验证合法换行停止序列不会被修剪或拒绝。
func TestRequestPreservesWhitespaceStopSequence(t *testing.T) {
	t.Parallel()

	text, err := NewTextContent("输出一段文本")
	if err != nil {
		t.Fatalf("NewTextContent() error = %v", err)
	}
	message, err := NewMessage(RoleUser, text)
	if err != nil {
		t.Fatalf("NewMessage() error = %v", err)
	}
	request, err := NewRequest(RequestInput{
		ClientProtocol: ClientProtocolOpenAIResponses,
		Model:          "gpt-5.6-sol",
		Messages:       []Message{message},
		StopSequences:  []string{"\n\n"},
	})
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	if got := request.StopSequences(); len(got) != 1 || got[0] != "\n\n" {
		t.Fatalf("StopSequences() = %#v, want exact newline sequence", got)
	}
}
