package inference

import (
	"errors"
	"testing"
)

// TestReasoningContinuityKeepsProviderDataDistinct 验证可见思考、签名、Responses
// 加密连续性和 Claude redacted 数据不会被合并成普通文本。
func TestReasoningContinuityKeepsProviderDataDistinct(t *testing.T) {
	t.Parallel()

	thinking, err := NewThinkingContent("先检查协议状态。", "signature_exact_1")
	if err != nil {
		t.Fatalf("NewThinkingContent() error = %v", err)
	}
	encrypted, err := NewEncryptedReasoningContent("encrypted_exact_1")
	if err != nil {
		t.Fatalf("NewEncryptedReasoningContent() error = %v", err)
	}
	redacted, err := NewRedactedReasoningContent("redacted_exact_1")
	if err != nil {
		t.Fatalf("NewRedactedReasoningContent() error = %v", err)
	}

	if thinking.Kind() != ContentReasoning || thinking.ReasoningKind() != ReasoningThinking {
		t.Fatalf("thinking = %#v, want reasoning thinking", thinking)
	}
	if thinking.Signature() != "signature_exact_1" ||
		encrypted.EncryptedData() != "encrypted_exact_1" ||
		redacted.ReasoningKind() != ReasoningRedacted ||
		redacted.RedactedData() != "redacted_exact_1" {
		t.Fatalf(
			"reasoning continuity lost: thinking=%#v encrypted=%#v redacted=%#v",
			thinking,
			encrypted,
			redacted,
		)
	}
	if _, ok := Content(thinking).(TextContent); ok {
		t.Fatal("thinking 不应能断言为 TextContent")
	}
}

// TestReasoningContinuityRejectsIncompleteValues 验证带签名思考和加密连续性必须完整，
// 防止 Adapter 静默丢失 Provider 要求的连续性数据。
func TestReasoningContinuityRejectsIncompleteValues(t *testing.T) {
	t.Parallel()

	if _, err := NewThinkingContent("先分析", ""); !errors.Is(err, ErrInvalidReasoning) {
		t.Fatalf("missing signature error = %v, want ErrInvalidReasoning", err)
	}
	if _, err := NewEncryptedReasoningContent(""); !errors.Is(err, ErrInvalidReasoning) {
		t.Fatalf("missing encrypted data error = %v, want ErrInvalidReasoning", err)
	}
	if _, err := NewRedactedReasoningContent(""); !errors.Is(err, ErrInvalidReasoning) {
		t.Fatalf("missing redacted data error = %v, want ErrInvalidReasoning", err)
	}
}
