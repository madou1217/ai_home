package messages

import (
	"encoding/base64"
	"testing"
)

// TestNormalizeClaudeThinkingSignatureCoversCurrentEnvelopes 验证 Claude
// classic、Antigravity double-layer 和 CAIS 三类源码已知 envelope。
func TestNormalizeClaudeThinkingSignatureCoversCurrentEnvelopes(t *testing.T) {
	t.Parallel()

	classic := testClaudeThinkingSignature()
	doubleLayer := base64.StdEncoding.EncodeToString([]byte(classic))
	cais := testClaudeCAISSignature()
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{name: "classic", raw: classic, want: classic},
		{name: "double layer", raw: doubleLayer, want: classic},
		{name: "cais", raw: cais, want: cais},
		{name: "claude cache prefix", raw: "ccmax#" + cais, want: cais},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			got, ok := normalizeClaudeThinkingSignature(test.raw)
			if !ok || got != test.want {
				t.Fatalf("normalizeClaudeThinkingSignature() = %q, %t, want %q, true", got, ok, test.want)
			}
		})
	}
}

// TestNormalizeClaudeThinkingSignatureRejectsOtherProviders 验证不能仅凭
// encrypted_content 字段名把 GPT 或未知数据伪造成 Claude thinking。
func TestNormalizeClaudeThinkingSignatureRejectsOtherProviders(t *testing.T) {
	t.Parallel()

	classic := testClaudeThinkingSignature()
	tests := []string{
		"gAAAAABopenai-encrypted-content",
		"gpt#" + classic,
		"unknown#" + classic,
		base64.StdEncoding.EncodeToString([]byte{0x12}),
		"E-not-base64",
	}
	for _, raw := range tests {
		if got, ok := normalizeClaudeThinkingSignature(raw); ok || got != "" {
			t.Fatalf("normalizeClaudeThinkingSignature(%q) = %q, %t, want empty, false", raw, got, ok)
		}
	}
}

// testClaudeCAISSignature 创建 Claude 新模型 C-form CAIS 测试 envelope。
func testClaudeCAISSignature() string {
	channel := appendTestProtoVarint(nil, 1, 16)
	channel = appendTestProtoVarint(channel, 3, 2)
	channel = appendTestProtoBytes(channel, 5, []byte("synthetic-ecdsa-signature"))
	channel = appendTestProtoBytes(channel, 6, []byte("claude-opus-5"))
	channel = appendTestProtoBytes(channel, 8, []byte("thinking"))
	channel = appendTestProtoBytes(
		channel,
		11,
		[]byte("123e4567-e89b-12d3-a456-426614174000"),
	)
	container := appendTestProtoBytes(nil, 1, channel)
	payload := appendTestProtoVarint(nil, 1, 2)
	payload = appendTestProtoBytes(payload, 2, container)
	payload = appendTestProtoVarint(payload, 3, 1)
	return base64.StdEncoding.EncodeToString(payload)
}
