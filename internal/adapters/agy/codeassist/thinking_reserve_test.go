package codeassist

import (
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

// TestWithThinkingReserveKeepsAnswerBudget 防回归：生产 Gemini canary 中 maxOutputTokens=64
// 全被默认思考吃光，答案为空（MAX_TOKENS）。Gemini 模型预留思考余量，Claude 模型不变。
func TestWithThinkingReserveKeepsAnswerBudget(t *testing.T) {
	t.Parallel()

	for _, testCase := range []struct {
		model string
		in    uint64
		want  uint64
	}{
		{model: "gemini-3-flash", in: 64, want: 64 + 8192},
		{model: "gemini-3.1-pro-high", in: 20000, want: 40000},
		{model: "gemini-3-flash", in: 60000, want: 60000 + 32768},
		{model: "gemini-3-flash", in: 0, want: 0},
		{model: "claude-opus-4-6-thinking", in: 64, want: 64},
	} {
		if got := withThinkingReserve(testCase.model, testCase.in); got != testCase.want {
			t.Fatalf("withThinkingReserve(%q, %d) = %d, want %d", testCase.model, testCase.in, got, testCase.want)
		}
	}
}

// TestEncodeMessagesDropsReasoningHistory 验证历史 reasoning 内容被丢弃而不是让请求失败。
func TestEncodeMessagesDropsReasoningHistory(t *testing.T) {
	t.Parallel()

	reasoning, err := inference.NewReasoningSummaryContent("earlier thought")
	if err != nil {
		t.Fatalf("NewReasoningSummaryContent() error = %v", err)
	}
	text, _ := inference.NewTextContent("hello")
	assistant, err := inference.NewMessage(inference.RoleAssistant, reasoning, text)
	if err != nil {
		t.Fatalf("NewMessage() error = %v", err)
	}
	contents, _, _, err := encodeMessages([]inference.Message{assistant}, toolNameMapper{})
	if err != nil {
		t.Fatalf("encodeMessages() error = %v", err)
	}
	if len(contents) != 1 || len(contents[0].Parts) != 1 || contents[0].Parts[0].Text != "hello" {
		t.Fatalf("contents = %#v", contents)
	}
}

// TestEncodeMessagesSendsInlineImages 验证 base64 图片编码为 Gemini inlineData，URL 图片按请求错误拒绝。
func TestEncodeMessagesSendsInlineImages(t *testing.T) {
	t.Parallel()

	source, err := inference.NewBase64MediaSource("image/png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/AAf/AAAAAElFTkSuQmCC")
	if err != nil {
		t.Fatal(err)
	}
	image, err := inference.NewImageContent(source, inference.ImageDetailAuto)
	if err != nil {
		t.Fatalf("NewImageContent() error = %v", err)
	}
	text, _ := inference.NewTextContent("what color?")
	user, err := inference.NewMessage(inference.RoleUser, image, text)
	if err != nil {
		t.Fatal(err)
	}
	contents, _, _, err := encodeMessages([]inference.Message{user}, toolNameMapper{})
	if err != nil {
		t.Fatalf("encodeMessages() error = %v", err)
	}
	parts := contents[0].Parts
	if len(parts) != 2 || parts[0].InlineData == nil || parts[0].InlineData.MimeType != "image/png" || parts[1].Text != "what color?" {
		t.Fatalf("parts = %#v", parts)
	}
}
