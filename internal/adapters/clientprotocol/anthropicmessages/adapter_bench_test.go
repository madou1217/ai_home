package anthropicmessages

import (
	"testing"
)

var benchmarkMessagesRequest = []byte(`{
	"model":"claude-opus-4-6",
	"max_tokens":8192,
	"system":"你是严谨的工程助手。",
	"messages":[
		{"role":"user","content":[
			{"type":"text","text":"查询账号状态"},
			{"type":"image","source":{"type":"url","url":"https://example.test/status.png"}}
		]},
		{"role":"assistant","content":[
			{"type":"tool_use","id":"toolu_bench_1","name":"lookup","input":{"account":"codex-1"}}
		]},
		{"role":"user","content":[
			{"type":"tool_result","tool_use_id":"toolu_bench_1","content":"available"}
		]}
	],
	"tools":[{
		"name":"lookup",
		"description":"查询账号",
		"input_schema":{"type":"object","properties":{"account":{"type":"string"}}}
	}],
	"tool_choice":{"type":"auto","disable_parallel_tool_use":false},
	"thinking":{"type":"adaptive"},
	"output_config":{"effort":"high"},
	"temperature":0.3,
	"top_p":0.9,
	"top_k":64,
	"stream":true
}`)

// BenchmarkRequestDecoder 测量完整 Messages 请求进入 Canonical Contract 的成本。
func BenchmarkRequestDecoder(b *testing.B) {
	decoder := NewRequestDecoder()
	b.ReportAllocs()
	for b.Loop() {
		request, err := decoder.Decode(benchmarkMessagesRequest)
		if err != nil {
			b.Fatal(err)
		}
		if request.Model() == "" {
			b.Fatal("empty model")
		}
	}
}

// BenchmarkStreamRenderer 测量 signed thinking、文本和工具调用的流式渲染成本。
func BenchmarkStreamRenderer(b *testing.B) {
	request := newRendererTestRequest(b)
	events := newThinkingTextToolResponseEvents(b)
	b.ReportAllocs()
	for b.Loop() {
		renderer := NewStreamRenderer(request)
		for _, event := range events {
			if _, err := renderer.Render(event); err != nil {
				b.Fatal(err)
			}
		}
	}
}
