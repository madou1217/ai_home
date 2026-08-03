package openairesponses

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/inference"
)

// TestStreamRendererProducesResponsesLifecycle 验证一个 Canonical 文本流会生成
// Responses created、增量、终值、输出项完成和 response.completed 生命周期。
func TestStreamRendererProducesResponsesLifecycle(t *testing.T) {
	t.Parallel()

	request := newRendererTestRequest(t, true)
	renderer := NewStreamRenderer(request, time.Unix(1_700_000_000, 0))
	events := newTextResponseEvents(t)

	var frames []RenderedEvent
	for _, event := range events {
		rendered, err := renderer.Render(event)
		if err != nil {
			t.Fatalf("Render(%q) error = %v", event.Kind(), err)
		}
		frames = append(frames, rendered...)
	}

	names := make([]string, len(frames))
	for index, frame := range frames {
		names[index] = frame.Name()
	}
	expected := []string{
		"response.created",
		"response.in_progress",
		"response.output_item.added",
		"response.content_part.added",
		"response.output_text.delta",
		"response.output_text.delta",
		"response.output_text.done",
		"response.content_part.done",
		"response.output_item.done",
		"response.completed",
	}
	if strings.Join(names, ",") != strings.Join(expected, ",") {
		t.Fatalf("frame names = %#v, want %#v", names, expected)
	}
	t.Logf("SSE event sequence: %s", strings.Join(names, " -> "))

	var deltaPayload struct {
		// Type 是 Responses SSE 事件类型。
		Type string `json:"type"`
		// ItemID 是文本所属输出项 ID。
		ItemID string `json:"item_id"`
		// Delta 是文本增量。
		Delta string `json:"delta"`
	}
	if err := json.Unmarshal(frames[4].Data(), &deltaPayload); err != nil {
		t.Fatalf("unmarshal delta error = %v", err)
	}
	if deltaPayload.Type != "response.output_text.delta" ||
		deltaPayload.ItemID != "msg_exact_1" ||
		deltaPayload.Delta != "你" {
		t.Fatalf("delta payload = %#v", deltaPayload)
	}

	var completedPayload struct {
		// Type 是 Responses SSE 事件类型。
		Type string `json:"type"`
		// Response 是最终 Responses 对象。
		Response struct {
			// ID 是响应 ID。
			ID string `json:"id"`
			// Status 是响应完成状态。
			Status string `json:"status"`
			// Output 是完整输出项数组。
			Output []json.RawMessage `json:"output"`
			// Usage 是最终 token 使用量。
			Usage struct {
				// InputTokens 是累计输入 token。
				InputTokens uint64 `json:"input_tokens"`
				// OutputTokens 是累计输出 token。
				OutputTokens uint64 `json:"output_tokens"`
				// TotalTokens 是累计总 token。
				TotalTokens uint64 `json:"total_tokens"`
			} `json:"usage"`
		} `json:"response"`
	}
	if err := json.Unmarshal(frames[len(frames)-1].Data(), &completedPayload); err != nil {
		t.Fatalf("unmarshal completed error = %v", err)
	}
	if completedPayload.Type != "response.completed" ||
		completedPayload.Response.ID != "resp_exact_1" ||
		completedPayload.Response.Status != "completed" ||
		len(completedPayload.Response.Output) != 1 ||
		completedPayload.Response.Usage.TotalTokens != 7 {
		t.Fatalf("completed payload = %#v", completedPayload)
	}
	t.Logf("completed SSE data: %s", frames[len(frames)-1].Data())
}

// TestStreamRendererEmitsURLCitationAnnotations 验证 Canonical 网页引用同时
// 出现在流式 annotation.added 与最终 output_text.annotations 中。
func TestStreamRendererEmitsURLCitationAnnotations(t *testing.T) {
	t.Parallel()

	renderer := NewStreamRenderer(
		newRendererTestRequest(t, true),
		time.Unix(1_700_000_000, 0),
	)
	citation, err := inference.NewURLCitation(
		4,
		4,
		"AIH",
		"https://example.com/aih",
	)
	if err != nil {
		t.Fatalf("NewURLCitation() error = %v", err)
	}
	started, _ := inference.NewResponseStartedEvent(0, "resp_citation", "claude-opus-5")
	itemStarted, _ := inference.NewOutputItemStartedEvent(1, 0, "msg_citation", inference.OutputItemMessage)
	blockStarted, _ := inference.NewContentBlockStartedEvent(2, 0, 0, inference.ContentText)
	delta, _ := inference.NewTextDeltaEvent(3, 0, 0, "根据资料")
	citationAdded, _ := inference.NewURLCitationAddedEvent(4, 0, 0, citation)
	textCompleted, _ := inference.NewTextCompletedEvent(5, 0, 0, "根据资料")
	blockCompleted := inference.NewContentBlockCompletedEvent(6, 0, 0)
	itemCompleted, _ := inference.NewOutputItemCompletedEvent(7, 0, "msg_citation")
	usage, _ := inference.NewUsage(inference.UsageInput{InputTokens: 1, OutputTokens: 1})
	completed, _ := inference.NewResponseCompletedEvent(8, inference.StopReasonEndTurn, "", usage)
	events := []inference.StreamEvent{
		started,
		itemStarted,
		blockStarted,
		delta,
		citationAdded,
		textCompleted,
		blockCompleted,
		itemCompleted,
		completed,
	}
	var frames []RenderedEvent
	for _, event := range events {
		rendered, renderErr := renderer.Render(event)
		if renderErr != nil {
			t.Fatalf("Render(%s) error = %v", event.Kind(), renderErr)
		}
		frames = append(frames, rendered...)
	}
	var annotationFrames int
	for _, frame := range frames {
		if frame.Name() != "response.output_text.annotation.added" {
			continue
		}
		annotationFrames++
		var payload struct {
			AnnotationIndex uint32             `json:"annotation_index"`
			Annotation      urlCitationWireDTO `json:"annotation"`
		}
		if err := json.Unmarshal(frame.Data(), &payload); err != nil {
			t.Fatalf("json.Unmarshal(annotation) error = %v", err)
		}
		if payload.AnnotationIndex != 0 ||
			payload.Annotation.Type != "url_citation" ||
			payload.Annotation.StartIndex != 4 ||
			payload.Annotation.URL != "https://example.com/aih" {
			t.Fatalf("annotation = %#v", payload)
		}
	}
	if annotationFrames != 1 {
		t.Fatalf("annotation frames = %d, want 1", annotationFrames)
	}
	var terminal struct {
		Response struct {
			Output []struct {
				Content []struct {
					Annotations []urlCitationWireDTO `json:"annotations"`
				} `json:"content"`
			} `json:"output"`
		} `json:"response"`
	}
	if err := json.Unmarshal(frames[len(frames)-1].Data(), &terminal); err != nil {
		t.Fatalf("json.Unmarshal(terminal) error = %v", err)
	}
	if len(terminal.Response.Output) != 1 ||
		len(terminal.Response.Output[0].Content) != 1 ||
		len(terminal.Response.Output[0].Content[0].Annotations) != 1 {
		t.Fatalf("terminal = %#v", terminal)
	}
}

// TestRenderersOmitEncryptedReasoningUnlessRequested 验证 include 只控制
// Responses 输出投影；未请求时仍保留摘要，但不泄漏 opaque continuity。
func TestRenderersOmitEncryptedReasoningUnlessRequested(t *testing.T) {
	t.Parallel()

	request := newRendererReasoningTestRequest(t, false, false)
	events := newSignedReasoningResponseEvents(t)
	aggregator := NewResponseAggregator(
		request,
		time.Unix(1_700_000_000, 0),
	)
	for _, event := range events {
		if err := aggregator.Add(event); err != nil {
			t.Fatalf("Add(%q) error = %v", event.Kind(), err)
		}
	}
	body, err := aggregator.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	var response struct {
		Output []reasoningItemWireDTO `json:"output"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if len(response.Output) != 1 ||
		len(response.Output[0].Summary) != 1 ||
		response.Output[0].Summary[0].Text != "可继续" ||
		response.Output[0].EncryptedContent != "" ||
		strings.Contains(string(body), "opaque-signature") {
		t.Fatalf("reasoning response = %s", body)
	}
}

// TestResponseAggregatorBuildsNonStreamingResponseFromSameEvents 验证非流式输出只聚合
// 同一 Canonical 事件，不维护第二套 Provider 响应转换逻辑。
func TestResponseAggregatorBuildsNonStreamingResponseFromSameEvents(t *testing.T) {
	t.Parallel()

	request := newRendererTestRequest(t, false)
	aggregator := NewResponseAggregator(request, time.Unix(1_700_000_000, 0))
	for _, event := range newTextResponseEvents(t) {
		if err := aggregator.Add(event); err != nil {
			t.Fatalf("Add(%q) error = %v", event.Kind(), err)
		}
	}
	body, err := aggregator.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}

	var response struct {
		// ID 是响应 ID。
		ID string `json:"id"`
		// Object 是 Responses 固定对象类型。
		Object string `json:"object"`
		// CreatedAt 是注入的确定性 Unix 秒。
		CreatedAt int64 `json:"created_at"`
		// Status 是响应完成状态。
		Status string `json:"status"`
		// Model 是上游确认模型。
		Model string `json:"model"`
		// Output 是完整输出项数组。
		Output []struct {
			// ID 是输出项 ID。
			ID string `json:"id"`
			// Type 是输出项类型。
			Type string `json:"type"`
			// Content 是消息内容数组。
			Content []struct {
				// Type 是内容类型。
				Type string `json:"type"`
				// Text 是完整文本。
				Text string `json:"text"`
			} `json:"content"`
		} `json:"output"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatalf("unmarshal response error = %v", err)
	}
	if response.ID != "resp_exact_1" ||
		response.Object != "response" ||
		response.CreatedAt != 1_700_000_000 ||
		response.Status != "completed" ||
		response.Model != "gpt-5.6-sol" ||
		len(response.Output) != 1 ||
		response.Output[0].ID != "msg_exact_1" ||
		response.Output[0].Content[0].Text != "你好" {
		t.Fatalf("response = %#v", response)
	}
}

// TestResponseRenderersPreserveFunctionCallIdentityAndArguments 验证流式和非流式输出
// 都使用 Provider 的 item ID、call ID、工具名和完整参数。
func TestResponseRenderersPreserveFunctionCallIdentityAndArguments(t *testing.T) {
	t.Parallel()

	request := newRendererTestRequest(t, false)
	aggregator := NewResponseAggregator(request, time.Unix(1_700_000_000, 0))
	events := newToolResponseEvents(t)
	for _, event := range events {
		if err := aggregator.Add(event); err != nil {
			t.Fatalf("Add(%q) error = %v", event.Kind(), err)
		}
	}
	body, err := aggregator.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}

	var response struct {
		// Output 是完整函数调用输出项数组。
		Output []struct {
			// ID 是 Provider 输出项 ID。
			ID string `json:"id"`
			// CallID 是客户端后续引用的调用 ID。
			CallID string `json:"call_id"`
			// Name 是工具名。
			Name string `json:"name"`
			// Arguments 是完整 JSON 参数字符串。
			Arguments string `json:"arguments"`
		} `json:"output"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatalf("unmarshal response error = %v", err)
	}
	if len(response.Output) != 1 ||
		response.Output[0].ID != "fc_exact_1" ||
		response.Output[0].CallID != "call_exact_1" ||
		response.Output[0].Name != "lookup" ||
		response.Output[0].Arguments != `{"query":"codex"}` {
		t.Fatalf("tool output = %#v", response.Output)
	}
}

// TestResponseAggregatorRejectsFailureAsSuccess 验证提前断流或 Provider 失败不会
// 伪造成 status=completed 的空响应。
func TestResponseAggregatorRejectsFailureAsSuccess(t *testing.T) {
	t.Parallel()

	request := newRendererTestRequest(t, false)
	aggregator := NewResponseAggregator(request, time.Unix(1_700_000_000, 0))
	started, err := inference.NewResponseStartedEvent(0, "resp_exact_1", "gpt-5.6-sol")
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	failure, err := inference.NewResponseFailure("stream_disconnected", "上游流提前中断", true)
	if err != nil {
		t.Fatalf("NewResponseFailure() error = %v", err)
	}
	failed, err := inference.NewResponseFailedEvent(1, failure)
	if err != nil {
		t.Fatalf("NewResponseFailedEvent() error = %v", err)
	}
	if err := aggregator.Add(started); err != nil {
		t.Fatalf("Add(started) error = %v", err)
	}
	if err := aggregator.Add(failed); err != nil {
		t.Fatalf("Add(failed) error = %v", err)
	}
	if _, err := aggregator.Marshal(); !errors.Is(err, ErrResponseFailed) {
		t.Fatalf("Marshal() error = %v, want ErrResponseFailed", err)
	}
}

// TestStreamRendererRejectsOutOfOrderEvents 验证内容增量不能出现在 response 和
// output item 开始之前。
func TestStreamRendererRejectsOutOfOrderEvents(t *testing.T) {
	t.Parallel()

	request := newRendererTestRequest(t, true)
	renderer := NewStreamRenderer(request, time.Unix(1_700_000_000, 0))
	delta, err := inference.NewTextDeltaEvent(0, 0, 0, "非法顺序")
	if err != nil {
		t.Fatalf("NewTextDeltaEvent() error = %v", err)
	}
	if _, err := renderer.Render(delta); !errors.Is(err, ErrInvalidEventSequence) {
		t.Fatalf("Render() error = %v, want ErrInvalidEventSequence", err)
	}
}

// TestStreamRendererProducesRefusalLifecycle 验证 refusal 使用独立事件，并在
// Provider 终值比已收到增量更长时补发缺失后缀。
func TestStreamRendererProducesRefusalLifecycle(t *testing.T) {
	t.Parallel()

	renderer := NewStreamRenderer(
		newRendererTestRequest(t, true),
		time.Unix(1_700_000_000, 0),
	)
	frames := renderTestEvents(t, renderer, newRefusalResponseEvents(t))
	assertRenderedNames(t, frames, []string{
		"response.created",
		"response.in_progress",
		"response.output_item.added",
		"response.content_part.added",
		"response.refusal.delta",
		"response.refusal.delta",
		"response.refusal.done",
		"response.content_part.done",
		"response.output_item.done",
		"response.completed",
	})

	var suffix struct {
		// Delta 是 Renderer 根据终值补发的缺失后缀。
		Delta string `json:"delta"`
	}
	if err := json.Unmarshal(frames[5].Data(), &suffix); err != nil {
		t.Fatalf("unmarshal refusal suffix error = %v", err)
	}
	if suffix.Delta != "能" {
		t.Fatalf("refusal suffix = %q, want %q", suffix.Delta, "能")
	}
}

// TestStreamRendererProducesReasoningSummaryLifecycle 验证 reasoning summary 的
// part、delta、done 生命周期独立于普通 output_text。
func TestStreamRendererProducesReasoningSummaryLifecycle(t *testing.T) {
	t.Parallel()

	renderer := NewStreamRenderer(
		newRendererTestRequest(t, true),
		time.Unix(1_700_000_000, 0),
	)
	frames := renderTestEvents(t, renderer, newReasoningResponseEvents(t))
	assertRenderedNames(t, frames, []string{
		"response.created",
		"response.in_progress",
		"response.output_item.added",
		"response.reasoning_summary_part.added",
		"response.reasoning_summary_text.delta",
		"response.reasoning_summary_text.delta",
		"response.reasoning_summary_text.done",
		"response.reasoning_summary_part.done",
		"response.output_item.done",
		"response.completed",
	})

	var done struct {
		// Text 是完整 reasoning 摘要。
		Text string `json:"text"`
	}
	if err := json.Unmarshal(frames[6].Data(), &done); err != nil {
		t.Fatalf("unmarshal reasoning done error = %v", err)
	}
	if done.Text != "先分析" {
		t.Fatalf("reasoning done text = %q, want %q", done.Text, "先分析")
	}
}

// TestStreamRendererProducesFunctionCallLifecycle 验证 function_call 只有在
// call ID 和工具名已知后才 added，并补发完整参数中缺失的后缀。
func TestStreamRendererProducesFunctionCallLifecycle(t *testing.T) {
	t.Parallel()

	renderer := NewStreamRenderer(
		newRendererTestRequest(t, true),
		time.Unix(1_700_000_000, 0),
	)
	frames := renderTestEvents(t, renderer, newToolResponseEvents(t))
	assertRenderedNames(t, frames, []string{
		"response.created",
		"response.in_progress",
		"response.output_item.added",
		"response.function_call_arguments.delta",
		"response.function_call_arguments.delta",
		"response.function_call_arguments.done",
		"response.output_item.done",
		"response.completed",
	})

	var done struct {
		// Name 是完整工具名。
		Name string `json:"name"`
		// Arguments 是完整 JSON 参数。
		Arguments string `json:"arguments"`
	}
	if err := json.Unmarshal(frames[5].Data(), &done); err != nil {
		t.Fatalf("unmarshal function done error = %v", err)
	}
	if done.Name != "lookup" || done.Arguments != `{"query":"codex"}` {
		t.Fatalf("function done = %#v", done)
	}
}

// TestStreamRendererProducesFailedTerminalEvent 验证 Provider 失败会生成
// response.failed，且只暴露低敏错误分类和安全说明。
func TestStreamRendererProducesFailedTerminalEvent(t *testing.T) {
	t.Parallel()

	renderer := NewStreamRenderer(
		newRendererTestRequest(t, true),
		time.Unix(1_700_000_000, 0),
	)
	started, err := inference.NewResponseStartedEvent(
		0,
		"resp_failed_1",
		"gpt-5.6-sol",
	)
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	failure, err := inference.NewResponseFailure(
		"upstream_unavailable",
		"上游暂时不可用",
		true,
	)
	if err != nil {
		t.Fatalf("NewResponseFailure() error = %v", err)
	}
	failed, err := inference.NewResponseFailedEvent(1, failure)
	if err != nil {
		t.Fatalf("NewResponseFailedEvent() error = %v", err)
	}
	frames := renderTestEvents(
		t,
		renderer,
		[]inference.StreamEvent{started, failed},
	)
	assertRenderedNames(t, frames, []string{
		"response.created",
		"response.in_progress",
		"response.failed",
	})

	var payload struct {
		// Response 是失败终态响应。
		Response struct {
			// Status 是 failed。
			Status string `json:"status"`
			// Error 是低敏错误对象。
			Error struct {
				// Code 是稳定错误分类。
				Code string `json:"code"`
				// Message 是安全说明。
				Message string `json:"message"`
			} `json:"error"`
		} `json:"response"`
	}
	if err := json.Unmarshal(frames[2].Data(), &payload); err != nil {
		t.Fatalf("unmarshal failed response error = %v", err)
	}
	if payload.Response.Status != "failed" ||
		payload.Response.Error.Code != "upstream_unavailable" ||
		payload.Response.Error.Message != "上游暂时不可用" {
		t.Fatalf("failed payload = %#v", payload)
	}
}

// TestStreamRendererFailsWithoutFabricatingIncompleteToolIdentity 验证工具 item
// 尚无 call ID 和工具名时，失败响应仍可发出且不会生成或猜测这些字段。
func TestStreamRendererFailsWithoutFabricatingIncompleteToolIdentity(t *testing.T) {
	t.Parallel()

	renderer := NewStreamRenderer(
		newRendererTestRequest(t, true),
		time.Unix(1_700_000_000, 0),
	)
	started, err := inference.NewResponseStartedEvent(
		0,
		"resp_tool_failed_1",
		"gpt-5.6-sol",
	)
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	itemStarted, err := inference.NewOutputItemStartedEvent(
		1,
		0,
		"fc_incomplete_1",
		inference.OutputItemToolCall,
	)
	if err != nil {
		t.Fatalf("NewOutputItemStartedEvent() error = %v", err)
	}
	failure, err := inference.NewResponseFailure(
		"stream_disconnected",
		"上游流提前中断",
		true,
	)
	if err != nil {
		t.Fatalf("NewResponseFailure() error = %v", err)
	}
	failed, err := inference.NewResponseFailedEvent(2, failure)
	if err != nil {
		t.Fatalf("NewResponseFailedEvent() error = %v", err)
	}
	frames := renderTestEvents(
		t,
		renderer,
		[]inference.StreamEvent{started, itemStarted, failed},
	)
	assertRenderedNames(t, frames, []string{
		"response.created",
		"response.in_progress",
		"response.failed",
	})

	var payload struct {
		// Response 是失败响应对象。
		Response struct {
			// Output 只包含已经向客户端曝光的输出项。
			Output []json.RawMessage `json:"output"`
		} `json:"response"`
	}
	if err := json.Unmarshal(frames[2].Data(), &payload); err != nil {
		t.Fatalf("unmarshal failed response error = %v", err)
	}
	if len(payload.Response.Output) != 0 {
		t.Fatalf("failed response output = %#v, want empty", payload.Response.Output)
	}
}

// TestStreamRendererUsesIndependentContinuousSequence 验证一个 Canonical 事件
// 展开成多个 Responses 事件时仍使用从零开始的连续客户端序号。
func TestStreamRendererUsesIndependentContinuousSequence(t *testing.T) {
	t.Parallel()

	renderer := NewStreamRenderer(
		newRendererTestRequest(t, true),
		time.Unix(1_700_000_000, 0),
	)
	frames := renderTestEvents(t, renderer, newTextResponseEvents(t))
	for index, frame := range frames {
		var payload struct {
			// SequenceNumber 是 Responses 客户端事件序号。
			SequenceNumber uint64 `json:"sequence_number"`
		}
		if err := json.Unmarshal(frame.Data(), &payload); err != nil {
			t.Fatalf("unmarshal frame[%d] error = %v", index, err)
		}
		if payload.SequenceNumber != uint64(index) {
			t.Fatalf(
				"frame[%d] sequence_number = %d, want %d",
				index,
				payload.SequenceNumber,
				index,
			)
		}
	}
}

// TestResponseAggregatorRejectsIncompleteResponse 验证非流式路径不会把尚未收到
// response.completed 的状态编码为成功响应。
func TestResponseAggregatorRejectsIncompleteResponse(t *testing.T) {
	t.Parallel()

	aggregator := NewResponseAggregator(
		newRendererTestRequest(t, false),
		time.Unix(1_700_000_000, 0),
	)
	started, err := inference.NewResponseStartedEvent(
		0,
		"resp_incomplete_1",
		"gpt-5.6-sol",
	)
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	if err := aggregator.Add(started); err != nil {
		t.Fatalf("Add(started) error = %v", err)
	}
	if _, err := aggregator.Marshal(); !errors.Is(err, ErrResponseNotCompleted) {
		t.Fatalf("Marshal() error = %v, want ErrResponseNotCompleted", err)
	}
}

// TestResponseAggregatorPreservesSupportedRequestOptions 验证 Decoder 已接受的
// reasoning、结构化输出、工具和采样选项不会在响应对象中静默丢失。
func TestResponseAggregatorPreservesSupportedRequestOptions(t *testing.T) {
	t.Parallel()

	request, err := NewRequestDecoder().Decode([]byte(`{
		"model":"gpt-5.6-sol",
		"input":"查询账号状态",
		"previous_response_id":"resp_previous_1",
		"max_output_tokens":512,
		"temperature":0.2,
		"top_p":0.8,
		"store":false,
		"truncation":"disabled",
		"parallel_tool_calls":false,
		"reasoning":{"effort":"high","summary":"concise"},
		"text":{"format":{
			"type":"json_schema",
			"name":"account_status",
			"description":"账号状态",
			"schema":{
				"type":"object",
				"properties":{"enabled":{"type":"boolean"}},
				"required":["enabled"]
			},
			"strict":true
		}},
		"tools":[{
			"type":"function",
			"name":"lookup_account",
			"description":"查询账号",
			"parameters":{
				"type":"object",
				"properties":{"account_ref":{"type":"string"}},
				"required":["account_ref"]
			},
			"strict":false
		}],
		"tool_choice":{"type":"function","name":"lookup_account"}
	}`))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	aggregator := NewResponseAggregator(request, time.Unix(1_700_000_000, 0))
	for _, event := range newTextResponseEvents(t) {
		if err := aggregator.Add(event); err != nil {
			t.Fatalf("Add(%q) error = %v", event.Kind(), err)
		}
	}
	body, err := aggregator.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}

	var response struct {
		// MaxOutputTokens 是请求的输出 token 上限。
		MaxOutputTokens uint64 `json:"max_output_tokens"`
		// Temperature 是请求的采样温度。
		Temperature float64 `json:"temperature"`
		// TopP 是请求的 nucleus sampling 概率。
		TopP float64 `json:"top_p"`
		// ParallelToolCalls 是并行工具调用意图。
		ParallelToolCalls bool `json:"parallel_tool_calls"`
		// PreviousResponseID 是精确历史响应引用。
		PreviousResponseID string `json:"previous_response_id"`
		// Store 是响应存储意图。
		Store bool `json:"store"`
		// Truncation 是上下文截断策略。
		Truncation string `json:"truncation"`
		// Reasoning 是 reasoning 请求配置。
		Reasoning struct {
			// Effort 是 reasoning 强度。
			Effort string `json:"effort"`
			// Summary 是 reasoning 摘要模式。
			Summary string `json:"summary"`
		} `json:"reasoning"`
		// Text 是结构化输出配置。
		Text struct {
			// Format 是 JSON Schema 格式。
			Format struct {
				// Type 是 json_schema。
				Type string `json:"type"`
				// Name 是输出合同名。
				Name string `json:"name"`
				// Strict 是严格输出意图。
				Strict bool `json:"strict"`
			} `json:"format"`
		} `json:"text"`
		// ToolChoice 是命名函数选择。
		ToolChoice struct {
			// Type 是 function。
			Type string `json:"type"`
			// Name 是函数名。
			Name string `json:"name"`
		} `json:"tool_choice"`
		// Tools 是函数工具列表。
		Tools []struct {
			// Name 是工具名。
			Name string `json:"name"`
			// Strict 是显式 strict 值。
			Strict *bool `json:"strict"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatalf("unmarshal response error = %v", err)
	}
	if response.MaxOutputTokens != 512 ||
		response.Temperature != 0.2 ||
		response.TopP != 0.8 ||
		response.ParallelToolCalls ||
		response.PreviousResponseID != "resp_previous_1" ||
		response.Store ||
		response.Truncation != "disabled" ||
		response.Reasoning.Effort != "high" ||
		response.Reasoning.Summary != "concise" ||
		response.Text.Format.Type != "json_schema" ||
		response.Text.Format.Name != "account_status" ||
		!response.Text.Format.Strict ||
		response.ToolChoice.Type != "function" ||
		response.ToolChoice.Name != "lookup_account" ||
		len(response.Tools) != 1 ||
		response.Tools[0].Name != "lookup_account" ||
		response.Tools[0].Strict == nil ||
		*response.Tools[0].Strict {
		t.Fatalf("response options = %#v", response)
	}
}

// TestRejectedEventDoesNotAdvanceCanonicalSequence 验证非法事件不会污染状态机序号，
// 修正后的同序号合法事件仍可继续处理。
func TestRejectedEventDoesNotAdvanceCanonicalSequence(t *testing.T) {
	t.Parallel()

	renderer := NewStreamRenderer(
		newRendererTestRequest(t, true),
		time.Unix(1_700_000_000, 0),
	)
	started, err := inference.NewResponseStartedEvent(
		0,
		"resp_recover_1",
		"gpt-5.6-sol",
	)
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	if _, err := renderer.Render(started); err != nil {
		t.Fatalf("Render(started) error = %v", err)
	}
	invalidBlock, err := inference.NewContentBlockStartedEvent(
		1,
		0,
		0,
		inference.ContentText,
	)
	if err != nil {
		t.Fatalf("NewContentBlockStartedEvent() error = %v", err)
	}
	if _, err := renderer.Render(invalidBlock); !errors.Is(err, ErrInvalidEventSequence) {
		t.Fatalf("Render(invalidBlock) error = %v, want ErrInvalidEventSequence", err)
	}
	validItem, err := inference.NewOutputItemStartedEvent(
		1,
		0,
		"msg_recover_1",
		inference.OutputItemMessage,
	)
	if err != nil {
		t.Fatalf("NewOutputItemStartedEvent() error = %v", err)
	}
	frames, err := renderer.Render(validItem)
	if err != nil {
		t.Fatalf("Render(validItem) error = %v", err)
	}
	assertRenderedNames(t, frames, []string{"response.output_item.added"})
}

// TestStreamRendererConsumesReasoningSignatureWithoutFabricatedDelta 验证
// Claude signature 只进入 reasoning 终态，不会生成 Responses 不存在的增量事件。
func TestStreamRendererConsumesReasoningSignatureWithoutFabricatedDelta(t *testing.T) {
	t.Parallel()

	renderer := NewStreamRenderer(
		newRendererReasoningTestRequest(t, true, true),
		time.Unix(1_700_000_000, 0),
	)
	events := newReasoningPrefixEvents(t)
	renderTestEvents(t, renderer, events)

	thinking, err := inference.NewReasoningDeltaEvent(
		3,
		0,
		0,
		inference.ReasoningDeltaThinking,
		"可继续",
	)
	if err != nil {
		t.Fatalf("NewReasoningDeltaEvent(thinking) error = %v", err)
	}
	frames, err := renderer.Render(thinking)
	if err != nil {
		t.Fatalf("Render(thinking) error = %v", err)
	}
	assertRenderedNames(t, frames, []string{
		"response.reasoning_summary_part.added",
		"response.reasoning_summary_text.delta",
	})

	signature, err := inference.NewReasoningDeltaEvent(
		4,
		0,
		0,
		inference.ReasoningDeltaSignature,
		"opaque-signature",
	)
	if err != nil {
		t.Fatalf("NewReasoningDeltaEvent(signature) error = %v", err)
	}
	frames, err = renderer.Render(signature)
	if err != nil {
		t.Fatalf("Render(signature) error = %v", err)
	}
	assertRenderedNames(t, frames, nil)

	content, err := inference.NewThinkingContent("可继续", "opaque-signature")
	if err != nil {
		t.Fatalf("NewThinkingContent() error = %v", err)
	}
	completed, err := inference.NewReasoningCompletedEvent(5, 0, 0, content)
	if err != nil {
		t.Fatalf("NewReasoningCompletedEvent() error = %v", err)
	}
	if _, err := renderer.Render(completed); err != nil {
		t.Fatalf("Render(completed) error = %v", err)
	}
	if _, err := renderer.Render(inference.NewContentBlockCompletedEvent(6, 0, 0)); err != nil {
		t.Fatalf("Render(block completed) error = %v", err)
	}
	itemCompleted, err := inference.NewOutputItemCompletedEvent(7, 0, "rs_reasoning_1")
	if err != nil {
		t.Fatalf("NewOutputItemCompletedEvent() error = %v", err)
	}
	frames, err = renderer.Render(itemCompleted)
	if err != nil {
		t.Fatalf("Render(item completed) error = %v", err)
	}
	var payload struct {
		Item reasoningItemWireDTO `json:"item"`
	}
	if len(frames) != 1 || json.Unmarshal(frames[0].Data(), &payload) != nil ||
		payload.Item.EncryptedContent != "opaque-signature" {
		t.Fatalf("output_item.done frames = %#v", frames)
	}
}

// TestRenderersRejectClaudeRedactedThinking 验证 Claude redacted_thinking 没有
// Responses 原生 carrier 时会显式拒绝，而不是冒充 encrypted_content。
func TestRenderersRejectClaudeRedactedThinking(t *testing.T) {
	t.Parallel()

	request := newRendererTestRequest(t, true)
	started, _ := inference.NewResponseStartedEvent(0, "resp_redacted_1", "claude-opus-5")
	itemStarted, _ := inference.NewOutputItemStartedEvent(
		1,
		0,
		"rs_redacted_1",
		inference.OutputItemReasoning,
	)
	blockStarted, _ := inference.NewContentBlockStartedEvent(
		2,
		0,
		0,
		inference.ContentReasoning,
	)
	redacted, err := inference.NewRedactedReasoningContent("claude-redacted-exact")
	if err != nil {
		t.Fatalf("NewRedactedReasoningContent() error = %v", err)
	}
	completed, err := inference.NewReasoningCompletedEvent(3, 0, 0, redacted)
	if err != nil {
		t.Fatalf("NewReasoningCompletedEvent() error = %v", err)
	}

	renderer := NewStreamRenderer(request, time.Unix(1_700_000_000, 0))
	for _, event := range []inference.StreamEvent{started, itemStarted, blockStarted} {
		if _, err := renderer.Render(event); err != nil {
			t.Fatalf("Render(%q) error = %v", event.Kind(), err)
		}
	}
	if _, err := renderer.Render(completed); !errors.Is(err, ErrUnsupportedResponseEvent) {
		t.Fatalf("Render(redacted) error = %v, want ErrUnsupportedResponseEvent", err)
	}

	aggregator := NewResponseAggregator(request, time.Unix(1_700_000_000, 0))
	for _, event := range []inference.StreamEvent{started, itemStarted, blockStarted} {
		if err := aggregator.Add(event); err != nil {
			t.Fatalf("Add(%q) error = %v", event.Kind(), err)
		}
	}
	if err := aggregator.Add(completed); !errors.Is(err, ErrUnsupportedResponseEvent) {
		t.Fatalf("Add(redacted) error = %v, want ErrUnsupportedResponseEvent", err)
	}
}
