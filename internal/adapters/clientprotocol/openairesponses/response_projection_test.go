package openairesponses

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
)

// TestAdapterBindsResponsesProjection 验证 Adapter 在一次请求内绑定客户端回显，
// 同时不把公开 metadata 混入 Provider 使用的 Canonical client_metadata。
func TestAdapterBindsResponsesProjection(t *testing.T) {
	t.Parallel()

	adapter, err := NewAdapter(func() time.Time {
		return time.Unix(1_700_000_000, 0)
	})
	if err != nil {
		t.Fatalf("NewAdapter() error = %v", err)
	}

	for _, testCase := range []struct {
		name   string
		stream bool
	}{
		{name: "非流式", stream: false},
		{name: "流式", stream: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			body := []byte(`{
				"model":"gpt-5.6-sol",
				"instructions":"只返回最终答案",
				"input":"你好",
				"metadata":{"ticket":"AIH-42"},
				"stream":` + boolJSON(testCase.stream) + `
			}`)
			exchange, err := adapter.Bind(body)
			if err != nil {
				t.Fatalf("Bind() error = %v", err)
			}
			if metadata := exchange.CanonicalRequest().ClientMetadata(); len(metadata) != 0 {
				t.Fatalf("公开 metadata 污染了 Canonical client_metadata: %#v", metadata)
			}

			response := renderBoundResponse(t, exchange, testCase.stream)
			assertResponsesProjection(t, response)
		})
	}
}

// renderBoundResponse 通过正式绑定对象渲染一个完整响应。
func renderBoundResponse(
	t testing.TB,
	exchange clientprotocol.Exchange,
	stream bool,
) []byte {
	t.Helper()

	events := newTextResponseEvents(t)
	if !stream {
		aggregator := exchange.NewResponseAggregator()
		for _, event := range events {
			if err := aggregator.Add(event); err != nil {
				t.Fatalf("Add(%q) error = %v", event.Kind(), err)
			}
		}
		body, err := aggregator.Marshal()
		if err != nil {
			t.Fatalf("Marshal() error = %v", err)
		}
		return body
	}

	renderer := exchange.NewStreamRenderer()
	var terminal []byte
	for _, event := range events {
		frames, err := renderer.Render(event)
		if err != nil {
			t.Fatalf("Render(%q) error = %v", event.Kind(), err)
		}
		for _, frame := range frames {
			if frame.Name() != "response.completed" {
				continue
			}
			var envelope struct {
				Response json.RawMessage `json:"response"`
			}
			if err := json.Unmarshal(frame.Data(), &envelope); err != nil {
				t.Fatalf("终态 SSE 无效: %v", err)
			}
			terminal = append([]byte(nil), envelope.Response...)
		}
	}
	if len(terminal) == 0 {
		t.Fatal("流式响应缺少 response.completed")
	}
	return terminal
}

// assertResponsesProjection 校验 OpenAI Responses 对象的必需回显字段与缺省值。
func assertResponsesProjection(t testing.TB, body []byte) {
	t.Helper()

	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		t.Fatalf("Responses JSON 无效: %v", err)
	}
	want := map[string]string{
		"instructions":        `"只返回最终答案"`,
		"metadata":            `{"ticket":"AIH-42"}`,
		"parallel_tool_calls": `true`,
		"temperature":         `null`,
		"tool_choice":         `"auto"`,
		"top_p":               `null`,
	}
	for field, expected := range want {
		actual, found := fields[field]
		if !found || !bytes.Equal(actual, []byte(expected)) {
			t.Fatalf("%s = %s, want %s", field, actual, expected)
		}
	}
}

// boolJSON 返回测试请求使用的 JSON 布尔字面量。
func boolJSON(value bool) string {
	if value {
		return "true"
	}
	return "false"
}
