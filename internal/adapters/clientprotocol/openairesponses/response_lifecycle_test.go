package openairesponses

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
)

// lifecycleResponseWire 保存生命周期契约测试关心的正式 Responses 字段。
type lifecycleResponseWire struct {
	// CreatedAt 是响应创建 Unix 秒。
	CreatedAt int64 `json:"created_at"`
	// CompletedAt 是仅 completed 终态携带的真实完成 Unix 秒。
	CompletedAt *int64 `json:"completed_at"`
	// Status 是 Responses 生命周期状态。
	Status string `json:"status"`
	// Error 是失败终态的低敏错误。
	Error *responseErrorWireDTO `json:"error"`
	// Usage 是成功或截断终态的 token 明细。
	Usage *usageWireDTO `json:"usage"`
	// Text 是正式文本输出配置。
	Text struct {
		// Format 是文本格式声明。
		Format struct {
			// Type 是 text 或 json_schema。
			Type string `json:"type"`
		} `json:"format"`
	} `json:"text"`
	// Tools 是请求声明的正式工具列表。
	Tools []json.RawMessage `json:"tools"`
}

// TestAdapterUsesTerminalClockForCompletedResponses 验证流式与非流式生产入口
// 都在真正完成时再次读取时钟，而不是把 created_at 复制成 completed_at。
func TestAdapterUsesTerminalClockForCompletedResponses(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name string
		run  func(testing.TB, Adapter, []inference.StreamEvent) []byte
	}{
		{
			name: "流式",
			run: func(t testing.TB, adapter Adapter, events []inference.StreamEvent) []byte {
				t.Helper()
				renderer := adapter.NewStreamRenderer(newRendererTestRequest(t, true))
				var terminal []byte
				for _, event := range events {
					frames, err := renderer.Render(event)
					if err != nil {
						t.Fatalf("Render(%q) error = %v", event.Kind(), err)
					}
					for _, frame := range frames {
						if frame.Name() == "response.completed" {
							terminal = frame.Data()
						}
					}
				}
				var envelope struct {
					Response json.RawMessage `json:"response"`
				}
				if err := json.Unmarshal(terminal, &envelope); err != nil {
					t.Fatalf("json.Unmarshal(stream terminal) error = %v", err)
				}
				return envelope.Response
			},
		},
		{
			name: "非流式",
			run: func(t testing.TB, adapter Adapter, events []inference.StreamEvent) []byte {
				t.Helper()
				aggregator := adapter.NewResponseAggregator(newRendererTestRequest(t, false))
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
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			createdAt := time.Unix(1_700_000_000, 0)
			completedAt := time.Unix(1_700_000_007, 0)
			clock, calls := newLifecycleTestClock(t, createdAt, completedAt)
			adapter, err := NewAdapter(clock)
			if err != nil {
				t.Fatalf("NewAdapter() error = %v", err)
			}
			body := test.run(t, adapter, newDetailedTextResponseEvents(t))
			response := decodeLifecycleResponse(t, body)
			if response.CreatedAt != createdAt.Unix() ||
				response.CompletedAt == nil ||
				*response.CompletedAt != completedAt.Unix() ||
				response.Status != statusCompleted {
				t.Fatalf("response lifecycle = %#v", response)
			}
			if calls() != 2 {
				t.Fatalf("clock calls = %d, want 2", calls())
			}
			if response.Error != nil || response.Usage == nil ||
				response.Usage.InputTokensDetails.CachedTokens != 2 ||
				response.Usage.InputTokensDetails.CacheWriteTokens != 1 ||
				response.Usage.OutputTokensDetails.ReasoningTokens != 3 ||
				response.Text.Format.Type != "text" || response.Tools == nil {
				t.Fatalf("official response fields = %#v", response)
			}
		})
	}
}

// TestAdapterOmitsCompletedAtForIncompleteResponse 验证截断终态保留 usage，
// 但不读取完成时钟，也不输出只属于 completed 状态的 completed_at。
func TestAdapterOmitsCompletedAtForIncompleteResponse(t *testing.T) {
	t.Parallel()

	createdAt := time.Unix(1_700_000_000, 0)
	clock, calls := newLifecycleTestClock(t, createdAt)
	adapter, err := NewAdapter(clock)
	if err != nil {
		t.Fatalf("NewAdapter() error = %v", err)
	}
	renderer := adapter.NewStreamRenderer(newRendererTestRequest(t, true))
	terminal := renderLifecycleTerminal(t, renderer, newRefusalResponseEvents(t), "response.incomplete")
	assertLifecycleFieldAbsent(t, terminal, "completed_at")
	response := decodeLifecycleResponse(t, terminal)
	if response.Status != statusIncomplete || response.Usage == nil || response.Error != nil {
		t.Fatalf("incomplete response = %#v", response)
	}
	if calls() != 1 {
		t.Fatalf("clock calls = %d, want 1", calls())
	}
}

// TestAdapterOmitsCompletedAtForFailedResponse 验证失败终态保留正式 error，
// 同时不伪造完成时间。
func TestAdapterOmitsCompletedAtForFailedResponse(t *testing.T) {
	t.Parallel()

	createdAt := time.Unix(1_700_000_000, 0)
	clock, calls := newLifecycleTestClock(t, createdAt)
	adapter, err := NewAdapter(clock)
	if err != nil {
		t.Fatalf("NewAdapter() error = %v", err)
	}
	started, err := inference.NewResponseStartedEvent(0, "resp_failed_clock", "gpt-5.6-sol")
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	failure, err := inference.NewResponseFailure("upstream_unavailable", "上游暂时不可用", true)
	if err != nil {
		t.Fatalf("NewResponseFailure() error = %v", err)
	}
	failed, err := inference.NewResponseFailedEvent(1, failure)
	if err != nil {
		t.Fatalf("NewResponseFailedEvent() error = %v", err)
	}
	renderer := adapter.NewStreamRenderer(newRendererTestRequest(t, true))
	terminal := renderLifecycleTerminal(
		t,
		renderer,
		[]inference.StreamEvent{started, failed},
		"response.failed",
	)
	assertLifecycleFieldAbsent(t, terminal, "completed_at")
	response := decodeLifecycleResponse(t, terminal)
	if response.Status != statusFailed || response.Error == nil ||
		response.Error.Code != "upstream_unavailable" ||
		response.Error.Message != "上游暂时不可用" || response.Usage != nil {
		t.Fatalf("failed response = %#v", response)
	}
	if calls() != 1 {
		t.Fatalf("clock calls = %d, want 1", calls())
	}
}

// newLifecycleTestClock 返回严格按顺序消费的时钟及调用次数读取器。
func newLifecycleTestClock(
	t testing.TB,
	instants ...time.Time,
) (func() time.Time, func() int) {
	t.Helper()

	index := 0
	clock := func() time.Time {
		if index >= len(instants) {
			t.Fatalf("clock called %d times, only %d instants", index+1, len(instants))
		}
		instant := instants[index]
		index++
		return instant
	}
	return clock, func() int { return index }
}

// newDetailedTextResponseEvents 为生命周期测试补齐缓存和 reasoning usage 明细。
func newDetailedTextResponseEvents(t testing.TB) []inference.StreamEvent {
	t.Helper()

	events := newTextResponseEvents(t)
	usage, err := inference.NewUsage(inference.UsageInput{
		InputTokens:           6,
		OutputTokens:          4,
		CachedInputTokens:     2,
		CacheWriteInputTokens: 1,
		ReasoningTokens:       3,
	})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	usageUpdated, err := inference.NewUsageUpdatedEvent(7, usage)
	if err != nil {
		t.Fatalf("NewUsageUpdatedEvent() error = %v", err)
	}
	completed, err := inference.NewResponseCompletedEvent(8, inference.StopReasonEndTurn, "", usage)
	if err != nil {
		t.Fatalf("NewResponseCompletedEvent() error = %v", err)
	}
	events[7] = usageUpdated
	events[8] = completed
	return events
}

// renderLifecycleTerminal 返回指定终态事件中的 response 原始 JSON。
func renderLifecycleTerminal(
	t testing.TB,
	renderer clientprotocol.StreamRenderer,
	events []inference.StreamEvent,
	eventName string,
) []byte {
	t.Helper()

	var terminal []byte
	for _, event := range events {
		frames, err := renderer.Render(event)
		if err != nil {
			t.Fatalf("Render(%q) error = %v", event.Kind(), err)
		}
		for _, frame := range frames {
			if frame.Name() != eventName {
				continue
			}
			var envelope struct {
				Response json.RawMessage `json:"response"`
			}
			if err := json.Unmarshal(frame.Data(), &envelope); err != nil {
				t.Fatalf("json.Unmarshal(%q) error = %v", eventName, err)
			}
			terminal = envelope.Response
		}
	}
	if len(terminal) == 0 {
		t.Fatalf("terminal event %q not rendered", eventName)
	}
	return terminal
}

// decodeLifecycleResponse 解码生命周期测试共用的 Responses 对象。
func decodeLifecycleResponse(t testing.TB, body []byte) lifecycleResponseWire {
	t.Helper()

	var response lifecycleResponseWire
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatalf("json.Unmarshal(response) error = %v", err)
	}
	return response
}

// assertLifecycleFieldAbsent 严格区分字段省略和显式 null。
func assertLifecycleFieldAbsent(t testing.TB, body []byte, field string) {
	t.Helper()

	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		t.Fatalf("json.Unmarshal(fields) error = %v", err)
	}
	if _, found := fields[field]; found {
		t.Fatalf("field %q must be omitted: %s", field, body)
	}
}
