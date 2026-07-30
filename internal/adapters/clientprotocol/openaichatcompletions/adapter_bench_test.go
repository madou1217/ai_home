package openaichatcompletions

import (
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/inference"
)

// benchmarkChatRequest 覆盖常用文本、工具、reasoning 和流式选项。
var benchmarkChatRequest = []byte(`{
	"model":"gpt-5.6-sol",
	"messages":[
		{"role":"system","content":"保持简洁"},
		{"role":"user","content":"查询深圳天气"}
	],
	"tools":[{
		"type":"function",
		"function":{
			"name":"weather",
			"description":"查询天气",
			"parameters":{"type":"object","properties":{"city":{"type":"string"}}},
			"strict":true
		}
	}],
	"tool_choice":"auto",
	"parallel_tool_calls":false,
	"reasoning_effort":"high",
	"stream":true,
	"stream_options":{"include_usage":true},
	"max_completion_tokens":2048
}`)

// BenchmarkRequestDecoder 测量严格 Chat JSON 到 Canonical Request 的成本。
func BenchmarkRequestDecoder(b *testing.B) {
	decoder := NewRequestDecoder()
	b.ReportAllocs()
	for b.Loop() {
		request, err := decoder.Decode(benchmarkChatRequest)
		if err != nil {
			b.Fatal(err)
		}
		if request.Model() == "" {
			b.Fatal("empty model")
		}
	}
}

// BenchmarkStreamRenderer 测量完整 Canonical 生命周期到 data-only SSE 的成本。
func BenchmarkStreamRenderer(b *testing.B) {
	request, err := NewRequestDecoder().Decode(benchmarkChatRequest)
	if err != nil {
		b.Fatal(err)
	}
	events := newBenchmarkChatEvents(b)
	createdAt := time.Unix(1_785_110_400, 0)
	b.ReportAllocs()
	for b.Loop() {
		renderer := NewStreamRenderer(request, createdAt)
		for _, event := range events {
			if _, renderErr := renderer.Render(event); renderErr != nil {
				b.Fatal(renderErr)
			}
		}
		if !renderer.Terminal() {
			b.Fatal("renderer did not terminate")
		}
	}
}

// newBenchmarkChatEvents 创建最小但完整的文本响应事件序列。
func newBenchmarkChatEvents(b *testing.B) []inference.StreamEvent {
	b.Helper()
	usage, err := inference.NewUsage(inference.UsageInput{
		InputTokens:  12,
		OutputTokens: 4,
	})
	if err != nil {
		b.Fatal(err)
	}
	events := make([]inference.StreamEvent, 0, 8)
	appendEvent := func(event inference.StreamEvent, eventErr error) {
		b.Helper()
		if eventErr != nil {
			b.Fatal(eventErr)
		}
		events = append(events, event)
	}
	appendEvent(inference.NewResponseStartedEvent(0, "resp_bench", "gpt-5.6-sol"))
	appendEvent(inference.NewOutputItemStartedEvent(
		1,
		0,
		"message_bench",
		inference.OutputItemMessage,
	))
	appendEvent(inference.NewContentBlockStartedEvent(
		2,
		0,
		0,
		inference.ContentText,
	))
	appendEvent(inference.NewTextDeltaEvent(3, 0, 0, "深圳晴天"))
	appendEvent(inference.NewTextCompletedEvent(4, 0, 0, "深圳晴天"))
	events = append(events, inference.NewContentBlockCompletedEvent(5, 0, 0))
	appendEvent(inference.NewOutputItemCompletedEvent(6, 0, "message_bench"))
	appendEvent(inference.NewResponseCompletedEvent(
		7,
		inference.StopReasonEndTurn,
		"",
		usage,
	))
	return events
}
