package openairesponses

import (
	"strings"
	"testing"
)

// TestDecodeToleratesCodexClientMessageMetadata 守住 Codex 0.171 起在 message 输入项上
// 携带的 internal_chat_message_metadata_passthrough：它是客户端自己的会话元数据，
// 上游协议没有对应表达。Canonical 必须丢弃它而不是把整轮请求判成 invalid_request
// （2026-11-27 线上 store=true 的请求就是这样整轮 400 的）。
func TestDecodeToleratesCodexClientMessageMetadata(t *testing.T) {
	body := `{
		"model": "gpt-6.2-sol",
		"stream": true,
		"store": true,
		"input": [{
			"type": "message",
			"role": "user",
			"content": [{"type": "input_text", "text": "hi"}],
			"internal_chat_message_metadata_passthrough": {
				"turn_id": "turn-1",
				"create_time": 1795780217.437347,
				"content_item_kinds": ["environments.environment_context"],
				"content_item_metadata": [{"provenance": {"type": "harness", "hook": false}}]
			}
		}]
	}`
	if _, err := NewRequestDecoder().Decode([]byte(body)); err != nil {
		t.Fatalf("decode rejected codex client metadata: %v", err)
	}

	// 只允许这一组已知字段；其它未知字段仍然必须拒绝，保持严格解码的边界。
	unknown := strings.Replace(body, "internal_chat_message_metadata_passthrough", "internal_chat_message_metadata_unknown", 1)
	if _, err := NewRequestDecoder().Decode([]byte(unknown)); err == nil {
		t.Fatal("unknown message field was accepted; strict decoding must stay in place")
	}
}
