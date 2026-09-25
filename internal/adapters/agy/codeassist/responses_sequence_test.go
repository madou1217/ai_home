package codeassist

import (
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/anthropicmessages"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/openairesponses"
)

// TestDecodedToolCallIsAValidResponsesSequence 防回归：Codex CLI 经 Responses 驱动 agy 时，
// 真实上游帧（空文本帧 + 函数调用帧 + 结束帧）必须形成 Responses 编码器接受的事件序列。
// 解码器曾给工具项发 ContentBlockCompleted，编码器以「Canonical 响应事件顺序无效」拒绝。
func TestDecodedToolCallIsAValidResponsesSequence(t *testing.T) {
	t.Parallel()

	aggregator := openairesponses.NewResponseAggregator(toolRoundTripRequest(t), time.Unix(1_790_000_000, 0).UTC())
	// Claude Code 经 /v1/messages 走同一个解码器，事件序列必须同时被 Messages 编码器接受。
	messages := anthropicmessages.NewResponseAggregator(toolRoundTripRequest(t))
	decoder := newResponseDecoder("claude-opus-4-6-thinking", func(event inference.StreamEvent) error {
		if err := messages.Add(event); err != nil {
			return err
		}
		return aggregator.Add(event)
	})
	frames := []string{
		`{"response":{"candidates":[{"content":{"role":"model","parts":[{"text":""}]}}]}}`,
		`{"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"checking"}]}}]}}`,
		`{"response":{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"lookup_weather","args":{"city":"Shanghai"},"id":"toolu_1"},"thoughtSignature":"sig"}]}}]}}`,
		`{"response":{"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5}}}`,
	}
	for index, frame := range frames {
		if err := decoder.Apply([]byte(frame)); err != nil {
			t.Fatalf("Apply(frame %d) error = %v", index, err)
		}
	}
	if !decoder.Terminal() {
		t.Fatal("decoder did not complete")
	}
	if _, err := aggregator.Marshal(); err != nil {
		t.Fatalf("Responses aggregator rejected the decoded sequence: %v", err)
	}
	if _, err := messages.Marshal(); err != nil {
		t.Fatalf("Messages aggregator rejected the decoded sequence: %v", err)
	}
}
