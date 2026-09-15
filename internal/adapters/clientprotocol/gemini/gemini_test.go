package gemini_test

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/gemini"
)

// fixedClock 为响应渲染提供稳定时间。
func fixedClock() time.Time {
	return time.Unix(1_700_000_000, 0).UTC()
}

// newTestAdapter 创建测试用 Gemini Adapter。
func newTestAdapter(t *testing.T) gemini.Adapter {
	t.Helper()
	adapter, err := gemini.NewAdapter(fixedClock)
	if err != nil {
		t.Fatalf("gemini.NewAdapter() error = %v", err)
	}
	return adapter
}

// testUsage 构造合法的用量快照。
func testUsage(t *testing.T, input uint64, output uint64) inference.Usage {
	t.Helper()
	usage, err := inference.NewUsage(inference.UsageInput{
		InputTokens:  input,
		OutputTokens: output,
	})
	if err != nil {
		t.Fatalf("inference.NewUsage() error = %v", err)
	}
	return usage
}

// TestDecodeWithModelBuildsCanonicalRequest 验证请求解码覆盖主要字段。
func TestDecodeWithModelBuildsCanonicalRequest(t *testing.T) {
	t.Parallel()

	adapter := newTestAdapter(t)
	body := []byte(`{
		"systemInstruction": {"parts": [{"text": "be terse"}]},
		"contents": [
			{"role": "user", "parts": [{"text": "hello"}]},
			{"role": "model", "parts": [{"text": "hi"}, {"functionCall": {"name": "search", "args": {"q": "x"}}}]},
			{"role": "user", "parts": [{"functionResponse": {"name": "search", "response": {"ok": true}}}]}
		],
		"generationConfig": {"temperature": 0.25, "topP": 0.9, "topK": 40, "maxOutputTokens": 128, "stopSequences": ["END"]},
		"tools": [{"functionDeclarations": [{"name": "search", "description": "d", "parameters": {"type": "object"}}]}],
		"toolConfig": {"functionCallingConfig": {"mode": "ANY"}}
	}`)

	request, err := adapter.DecodeWithModel("gemini-3.0-pro", body, true)
	if err != nil {
		t.Fatalf("DecodeWithModel() error = %v", err)
	}
	if request.Model() != "gemini-3.0-pro" ||
		request.ClientProtocol() != inference.ClientProtocolGeminiGenerateContent ||
		!request.Stream() {
		t.Fatalf("request = %#v", request)
	}
	if len(request.Messages()) != 4 {
		t.Fatalf("messages = %d, want 4", len(request.Messages()))
	}
	if request.Messages()[0].Role() != inference.RoleSystem {
		t.Fatalf("first role = %q, want system", request.Messages()[0].Role())
	}
	if len(request.Tools()) != 1 || request.Tools()[0].Name() != "search" {
		t.Fatalf("tools = %#v", request.Tools())
	}
	choice, found := request.ToolChoice()
	if !found || choice.Mode() != inference.ToolChoiceRequired {
		t.Fatalf("tool_choice = %#v found=%v", choice, found)
	}
	temperature, found := request.Temperature()
	if !found || temperature != 0.25 {
		t.Fatalf("temperature = %v found=%v", temperature, found)
	}
	if maxTokens := request.MaxOutputTokens(); maxTokens != 128 {
		t.Fatalf("max_output_tokens = %d", maxTokens)
	}
	if got := request.StopSequences(); len(got) != 1 || got[0] != "END" {
		t.Fatalf("stop_sequences = %#v", got)
	}
}

// TestDecodeWithModelRejectsMissingModel 验证缺少路径模型名时失败关闭。
func TestDecodeWithModelRejectsMissingModel(t *testing.T) {
	t.Parallel()

	adapter := newTestAdapter(t)
	if _, err := adapter.DecodeWithModel("  ", []byte(`{}`), false); !errors.Is(
		err,
		gemini.ErrModelRequired,
	) {
		t.Fatalf("error = %v, want ErrModelRequired", err)
	}
	// clientprotocol.Adapter 的无模型入口必须失败，避免产出模型为空的请求。
	if _, err := adapter.Decode([]byte(`{}`)); !errors.Is(err, gemini.ErrModelRequired) {
		t.Fatalf("Decode() error = %v, want ErrModelRequired", err)
	}
	if _, err := adapter.Bind([]byte(`{}`)); !errors.Is(err, gemini.ErrModelRequired) {
		t.Fatalf("Bind() error = %v, want ErrModelRequired", err)
	}
}

// TestDecodeWithModelRejectsUnsupportedFields 验证无法无损表达的功能被明确拒绝。
func TestDecodeWithModelRejectsUnsupportedFields(t *testing.T) {
	t.Parallel()

	adapter := newTestAdapter(t)
	tests := []struct {
		name string
		body string
	}{
		{
			name: "multiple candidates",
			body: `{"contents":[{"parts":[{"text":"x"}]}],"generationConfig":{"candidateCount":2}}`,
		},
		{
			name: "unknown tool calling mode",
			body: `{"contents":[{"parts":[{"text":"x"}]}],"toolConfig":{"functionCallingConfig":{"mode":"WHATEVER"}}}`,
		},
		{
			name: "unknown part type",
			body: `{"contents":[{"parts":[{"video":{"uri":"x"}}]}]}`,
		},
		{
			name: "unknown role",
			body: `{"contents":[{"role":"robot","parts":[{"text":"x"}]}]}`,
		},
		{
			name: "empty contents",
			body: `{"contents":[]}`,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if _, err := adapter.DecodeWithModel("m", []byte(test.body), false); err == nil {
				t.Fatal("expected a decode error")
			}
		})
	}
}

// TestDecodeWithModelAcceptsInlineImage 验证内联图片被无损保留。
func TestDecodeWithModelAcceptsInlineImage(t *testing.T) {
	t.Parallel()

	adapter := newTestAdapter(t)
	body := []byte(`{"contents":[{"role":"user","parts":[
		{"text":"what is this"},
		{"inlineData":{"mimeType":"image/png","data":"iVBORw0KGgo="}}
	]}]}`)
	request, err := adapter.DecodeWithModel("m", body, false)
	if err != nil {
		t.Fatalf("DecodeWithModel() error = %v", err)
	}
	contents := request.Messages()[0].Contents()
	if len(contents) != 2 || contents[1].Kind() != inference.ContentImage {
		t.Fatalf("contents = %#v", contents)
	}
}

// TestDecodeWithModelPairsFunctionCallAndResponseByName 验证缺少调用 ID 时按函数名配对。
func TestDecodeWithModelPairsFunctionCallAndResponseByName(t *testing.T) {
	t.Parallel()

	adapter := newTestAdapter(t)
	body := []byte(`{"contents":[
		{"role":"model","parts":[{"functionCall":{"name":"search","args":{"q":"x"}}}]},
		{"role":"user","parts":[{"functionResponse":{"name":"search","response":{"hits":1}}}]}
	]}`)
	request, err := adapter.DecodeWithModel("m", body, false)
	if err != nil {
		t.Fatalf("DecodeWithModel() error = %v", err)
	}
	call, ok := request.Messages()[0].Contents()[0].(inference.ToolCallContent)
	if !ok || call.CallID() != "search" {
		t.Fatalf("tool call = %#v", request.Messages()[0].Contents()[0])
	}
	result, ok := request.Messages()[1].Contents()[0].(inference.ToolResultContent)
	if !ok || result.CallID() != "search" {
		t.Fatalf("tool result = %#v", request.Messages()[1].Contents()[0])
	}
}

// TestAggregatorBuildsGeminiResponse 验证非流式聚合产出官方响应形状。
func TestAggregatorBuildsGeminiResponse(t *testing.T) {
	t.Parallel()

	adapter := newTestAdapter(t)
	request, err := adapter.DecodeWithModel("m", []byte(`{"contents":[{"parts":[{"text":"x"}]}]}`), false)
	if err != nil {
		t.Fatalf("DecodeWithModel() error = %v", err)
	}
	aggregator := adapter.NewResponseAggregator(request)

	apply := func(event inference.StreamEvent, err error) {
		t.Helper()
		if err != nil {
			t.Fatalf("event construction error = %v", err)
		}
		if err := aggregator.Add(event); err != nil {
			t.Fatalf("Add() error = %v", err)
		}
	}
	delta, err := inference.NewTextDeltaEvent(1, 0, 0, "hel")
	apply(delta, err)
	delta2, err := inference.NewTextDeltaEvent(2, 0, 0, "lo")
	apply(delta2, err)
	completed, err := inference.NewResponseCompletedEvent(
		3,
		inference.StopReasonEndTurn,
		"",
		testUsage(t, 7, 2),
	)
	apply(completed, err)

	encoded, err := aggregator.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	var document struct {
		Candidates []struct {
			Content struct {
				Role  string `json:"role"`
				Parts []struct {
					Text *string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
			FinishReason string `json:"finishReason"`
			Index        int    `json:"index"`
		} `json:"candidates"`
		UsageMetadata struct {
			PromptTokenCount     uint64 `json:"promptTokenCount"`
			CandidatesTokenCount uint64 `json:"candidatesTokenCount"`
			TotalTokenCount      uint64 `json:"totalTokenCount"`
		} `json:"usageMetadata"`
	}
	if err := json.Unmarshal(encoded, &document); err != nil {
		t.Fatalf("json.Unmarshal() error = %v body=%s", err, encoded)
	}
	if len(document.Candidates) != 1 ||
		document.Candidates[0].Content.Role != "model" ||
		document.Candidates[0].FinishReason != "STOP" ||
		document.Candidates[0].Index != 0 {
		t.Fatalf("candidates = %#v", document.Candidates)
	}
	if got := document.Candidates[0].Content.Parts; len(got) != 1 ||
		got[0].Text == nil || *got[0].Text != "hello" {
		t.Fatalf("parts = %#v", got)
	}
	if document.UsageMetadata.PromptTokenCount != 7 ||
		document.UsageMetadata.CandidatesTokenCount != 2 ||
		document.UsageMetadata.TotalTokenCount != 9 {
		t.Fatalf("usage = %#v", document.UsageMetadata)
	}
}

// TestAggregatorRefusesIncompleteAndFailedResponses 验证非流式只在成功终态后编码。
func TestAggregatorRefusesIncompleteAndFailedResponses(t *testing.T) {
	t.Parallel()

	adapter := newTestAdapter(t)
	request, err := adapter.DecodeWithModel("m", []byte(`{"contents":[{"parts":[{"text":"x"}]}]}`), false)
	if err != nil {
		t.Fatalf("DecodeWithModel() error = %v", err)
	}

	incomplete := adapter.NewResponseAggregator(request)
	delta, _ := inference.NewTextDeltaEvent(1, 0, 0, "hi")
	if err := incomplete.Add(delta); err != nil {
		t.Fatalf("Add() error = %v", err)
	}
	if _, err := incomplete.Marshal(); !errors.Is(err, gemini.ErrResponseNotCompleted) {
		t.Fatalf("Marshal() error = %v, want ErrResponseNotCompleted", err)
	}
}

// TestStreamRendererEmitsDataOnlyFrames 验证流式渲染输出 data-only SSE 帧。
func TestStreamRendererEmitsDataOnlyFrames(t *testing.T) {
	t.Parallel()

	adapter := newTestAdapter(t)
	request, err := adapter.DecodeWithModel("m", []byte(`{"contents":[{"parts":[{"text":"x"}]}]}`), true)
	if err != nil {
		t.Fatalf("DecodeWithModel() error = %v", err)
	}
	renderer := adapter.NewStreamRenderer(request)

	delta, _ := inference.NewTextDeltaEvent(1, 0, 0, "hi")
	frames, err := renderer.Render(delta)
	if err != nil {
		t.Fatalf("Render() error = %v", err)
	}
	if len(frames) != 1 {
		t.Fatalf("frames = %d, want 1", len(frames))
	}
	if frames[0].Name() != "" {
		t.Fatalf("frame name = %q, want empty (Gemini uses data-only frames)", frames[0].Name())
	}
	if !strings.Contains(string(frames[0].Data()), `"text":"hi"`) {
		t.Fatalf("frame data = %s", frames[0].Data())
	}
	if renderer.Terminal() {
		t.Fatal("renderer should not be terminal before the completed event")
	}

	completed, _ := inference.NewResponseCompletedEvent(
		2,
		inference.StopReasonEndTurn,
		"",
		testUsage(t, 1, 1),
	)
	frames, err = renderer.Render(completed)
	if err != nil {
		t.Fatalf("Render(completed) error = %v", err)
	}
	if len(frames) != 1 || !strings.Contains(string(frames[0].Data()), `"finishReason":"STOP"`) {
		t.Fatalf("completion frame = %v", frames)
	}
	if !renderer.Terminal() {
		t.Fatal("renderer should be terminal after the completed event")
	}
	// 终态之后不得再接受事件。
	if _, err := renderer.Render(delta); !errors.Is(err, gemini.ErrInvalidEventSequence) {
		t.Fatalf("Render() after terminal error = %v", err)
	}
}

// TestStreamRendererEmitsToolCallOnCompletion 验证工具调用只在参数完整时成帧。
//
// Gemini 的 functionCall.args 是对象而不是字符串增量，逐段下发会造成参数被反复覆盖。
func TestStreamRendererEmitsToolCallOnCompletion(t *testing.T) {
	t.Parallel()

	adapter := newTestAdapter(t)
	request, err := adapter.DecodeWithModel("m", []byte(`{"contents":[{"parts":[{"text":"x"}]}]}`), true)
	if err != nil {
		t.Fatalf("DecodeWithModel() error = %v", err)
	}
	renderer := adapter.NewStreamRenderer(request)

	started, _ := inference.NewToolCallStartedEvent(1, 0, 0, "call_1", "search")
	frames, err := renderer.Render(started)
	if err != nil {
		t.Fatalf("Render(started) error = %v", err)
	}
	if len(frames) != 0 {
		t.Fatalf("started frames = %v, want none", frames)
	}

	argumentsDelta, _ := inference.NewToolArgumentsDeltaEvent(2, 0, 0, "call_1", `{"q"`)
	if frames, err = renderer.Render(argumentsDelta); err != nil || len(frames) != 0 {
		t.Fatalf("arguments delta frames = %v error = %v", frames, err)
	}

	completed, _ := inference.NewToolCallCompletedEvent(
		3,
		0,
		0,
		"call_1",
		"search",
		[]byte(`{"q":"x"}`),
	)
	frames, err = renderer.Render(completed)
	if err != nil {
		t.Fatalf("Render(completed) error = %v", err)
	}
	if len(frames) != 1 {
		t.Fatalf("completed frames = %d, want 1", len(frames))
	}
	data := string(frames[0].Data())
	if !strings.Contains(data, `"functionCall"`) ||
		!strings.Contains(data, `"name":"search"`) ||
		!strings.Contains(data, `"q":"x"`) {
		t.Fatalf("frame data = %s", data)
	}
}

// TestAggregatorPreservesReasoningAsThoughtPart 验证 reasoning 映射为 thought 内容块。
func TestAggregatorPreservesReasoningAsThoughtPart(t *testing.T) {
	t.Parallel()

	adapter := newTestAdapter(t)
	request, err := adapter.DecodeWithModel("m", []byte(`{"contents":[{"parts":[{"text":"x"}]}]}`), false)
	if err != nil {
		t.Fatalf("DecodeWithModel() error = %v", err)
	}
	aggregator := adapter.NewResponseAggregator(request)

	reasoning, err := inference.NewReasoningDeltaEvent(
		1,
		0,
		0,
		inference.ReasoningDeltaSummary,
		"thinking",
	)
	if err != nil {
		t.Fatalf("NewReasoningSummaryDeltaEvent() error = %v", err)
	}
	if err := aggregator.Add(reasoning); err != nil {
		t.Fatalf("Add() error = %v", err)
	}
	completed, _ := inference.NewResponseCompletedEvent(
		2,
		inference.StopReasonEndTurn,
		"",
		testUsage(t, 1, 1),
	)
	if err := aggregator.Add(completed); err != nil {
		t.Fatalf("Add() error = %v", err)
	}
	encoded, err := aggregator.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	if !strings.Contains(string(encoded), `"thought":true`) {
		t.Fatalf("encoded = %s", encoded)
	}
}

// TestMapFinishReasonRejectsUnknownReasons 验证未知终止原因不被静默降级。
func TestMapFinishReasonRejectsUnknownReasons(t *testing.T) {
	t.Parallel()

	adapter := newTestAdapter(t)
	request, err := adapter.DecodeWithModel("m", []byte(`{"contents":[{"parts":[{"text":"x"}]}]}`), false)
	if err != nil {
		t.Fatalf("DecodeWithModel() error = %v", err)
	}
	aggregator := adapter.NewResponseAggregator(request)

	// 零值 StopReason 不属于任何已建模原因。
	completed, err := inference.NewResponseCompletedEvent(
		1,
		inference.StopReason("something_new"),
		"",
		testUsage(t, 1, 1),
	)
	if err == nil {
		if addErr := aggregator.Add(completed); !errors.Is(addErr, gemini.ErrUnsupportedResponseEvent) {
			t.Fatalf("Add() error = %v, want ErrUnsupportedResponseEvent", addErr)
		}
	}
}
