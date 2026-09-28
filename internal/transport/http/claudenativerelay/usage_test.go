package claudenativerelay

import (
	"strings"
	"testing"
	"time"
)

// TestObserveNativeStreamAccumulatesUsage 验证 message_start 输入与 message_delta 输出合并，
// 与 Claude Messages 适配器同口径（输入含缓存读写）。
func TestObserveNativeStreamAccumulatesUsage(t *testing.T) {
	t.Parallel()

	stream := strings.Join([]string{
		"event: message_start",
		`data: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":10,"cache_creation_input_tokens":200,"cache_read_input_tokens":3000,"output_tokens":1}}}`,
		"",
		"event: message_delta",
		`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}`,
		"",
		"event: message_stop",
		`data: {"type":"message_stop"}`,
		"",
		"",
	}, "\n")
	observed := observeNativeStream(strings.NewReader(stream), nil, func() time.Time {
		return time.Date(2026, 9, 29, 10, 0, 0, 0, time.UTC)
	})
	if !observed.completed || observed.failed {
		t.Fatalf("observation = %+v", observed)
	}
	usage, ok := observed.usage.canonical()
	if !ok || usage.InputTokens() != 3210 || usage.CachedInputTokens() != 3000 ||
		usage.CacheWriteInputTokens() != 200 || usage.OutputTokens() != 42 || usage.TotalTokens() != 3252 {
		t.Fatalf("usage = %+v ok=%v", usage, ok)
	}
}

// TestNativeUsageFromNonStreamBody 验证非流式 JSON 顶层 usage 与超限放弃。
func TestNativeUsageFromNonStreamBody(t *testing.T) {
	t.Parallel()

	var state nativeUsageState
	state.observe([]byte(`{"id":"m","type":"message","usage":{"input_tokens":7,"output_tokens":3}}`))
	if usage, ok := state.canonical(); !ok || usage.TotalTokens() != 10 {
		t.Fatalf("usage = %+v ok=%v", usage, ok)
	}
	capture := &boundedCapture{limit: 4}
	_, _ = capture.Write([]byte("abc"))
	_, _ = capture.Write([]byte("de"))
	if !capture.truncated || capture.buffer.Len() != 0 {
		t.Fatalf("capture should give up past the limit: %+v", capture)
	}
}
