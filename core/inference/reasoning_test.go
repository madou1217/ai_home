package inference

import (
	"errors"
	"testing"
)

// TestReasoningContinuityKeepsThinkingSignatureAndEncryptedDataDistinct 验证可见思考、
// 签名和加密连续性不会被合并成普通文本。
func TestReasoningContinuityKeepsThinkingSignatureAndEncryptedDataDistinct(t *testing.T) {
	t.Parallel()

	thinking, err := NewThinkingContent("先检查协议状态。", "signature_exact_1")
	if err != nil {
		t.Fatalf("NewThinkingContent() error = %v", err)
	}
	encrypted, err := NewEncryptedReasoningContent("encrypted_exact_1")
	if err != nil {
		t.Fatalf("NewEncryptedReasoningContent() error = %v", err)
	}

	if thinking.Kind() != ContentReasoning || thinking.ReasoningKind() != ReasoningThinking {
		t.Fatalf("thinking = %#v, want reasoning thinking", thinking)
	}
	if thinking.Signature() != "signature_exact_1" || encrypted.EncryptedData() != "encrypted_exact_1" {
		t.Fatalf("reasoning continuity lost: thinking=%#v encrypted=%#v", thinking, encrypted)
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
}
