package openairesponses

import (
	"testing"
	"time"
)

// BenchmarkRequestDecoder 测量典型 Responses 文本和函数工具请求的严格解码成本。
func BenchmarkRequestDecoder(b *testing.B) {
	decoder := NewRequestDecoder()
	body := []byte(`{
		"model":"gpt-5.6-sol",
		"input":"查询账号状态",
		"stream":true,
		"tools":[{
			"type":"function",
			"name":"lookup_account",
			"description":"查询账号状态",
			"parameters":{
				"type":"object",
				"properties":{"account_ref":{"type":"string"}},
				"required":["account_ref"]
			},
			"strict":true
		}],
		"tool_choice":"auto",
		"parallel_tool_calls":false,
		"reasoning":{"effort":"medium","summary":"concise"}
	}`)

	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		if _, err := decoder.Decode(body); err != nil {
			b.Fatalf("Decode() error = %v", err)
		}
	}
}

// BenchmarkStreamRendererTextResponse 测量典型文本响应完整 SSE 生命周期的渲染成本。
func BenchmarkStreamRendererTextResponse(b *testing.B) {
	request := newRendererTestRequest(b, true)
	events := newTextResponseEvents(b)
	createdAt := time.Unix(1_700_000_000, 0)

	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		renderer := NewStreamRenderer(request, createdAt)
		for _, event := range events {
			if _, err := renderer.Render(event); err != nil {
				b.Fatalf("Render(%q) error = %v", event.Kind(), err)
			}
		}
	}
}
