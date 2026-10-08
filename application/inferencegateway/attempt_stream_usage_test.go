package inferencegateway

import (
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/inference"
)

// TestAttemptStreamKeepsLastCumulativeUsage 验证尝试流保留最后一个累计 usage，
// 并由 AttemptSuccess.WithUsage 带给运行态记账（账号 Token 用量）。
func TestAttemptStreamKeepsLastCumulativeUsage(t *testing.T) {
	t.Parallel()

	stream := newAttemptStream(func(inference.StreamEvent) error { return nil }, time.Now)
	if _, ok := stream.Usage(); ok {
		t.Fatal("fresh stream must not report usage")
	}
	for sequence, output := range []uint64{1, 7} {
		usage, err := inference.NewUsage(inference.UsageInput{InputTokens: 50, OutputTokens: output})
		if err != nil {
			t.Fatalf("NewUsage() error = %v", err)
		}
		event, err := inference.NewUsageUpdatedEvent(uint64(sequence), usage)
		if err != nil {
			t.Fatalf("NewUsageUpdatedEvent() error = %v", err)
		}
		if err := stream.Accept(event); err != nil {
			t.Fatalf("Accept() error = %v", err)
		}
	}
	usage, ok := stream.Usage()
	if !ok || usage.TotalTokens() != 57 {
		t.Fatalf("stream usage = %+v ok=%v", usage, ok)
	}
	success, err := NewAttemptSuccess(time.Now())
	if err != nil {
		t.Fatalf("NewAttemptSuccess() error = %v", err)
	}
	if _, ok := success.Usage(); ok {
		t.Fatal("plain success must not carry usage")
	}
	if carried, ok := success.WithUsage(usage).Usage(); !ok || carried.TotalTokens() != 57 {
		t.Fatalf("WithUsage = %+v ok=%v", carried, ok)
	}
}

// TestAttemptStreamUsesCompletedUsage 验证没有中间 usage 事件时，成功终态携带的
// 最终累计快照仍会进入账号用量记账；终态快照也必须覆盖中间快照。
func TestAttemptStreamUsesCompletedUsage(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		intermediate bool
	}{
		{name: "terminal_only"},
		{name: "terminal_overrides_interim", intermediate: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			stream := newAttemptStream(func(inference.StreamEvent) error { return nil }, time.Now)
			sequence := uint64(0)
			if test.intermediate {
				interim, err := inference.NewUsage(inference.UsageInput{InputTokens: 8, OutputTokens: 1})
				if err != nil {
					t.Fatalf("NewUsage() interim error = %v", err)
				}
				event, err := inference.NewUsageUpdatedEvent(sequence, interim)
				if err != nil {
					t.Fatalf("NewUsageUpdatedEvent() error = %v", err)
				}
				if err := stream.Accept(event); err != nil {
					t.Fatalf("Accept(interim) error = %v", err)
				}
				sequence++
			}

			final, err := inference.NewUsage(inference.UsageInput{
				InputTokens:           8,
				OutputTokens:          5,
				CachedInputTokens:     3,
				CacheWriteInputTokens: 2,
				ReasoningTokens:       2,
			})
			if err != nil {
				t.Fatalf("NewUsage() final error = %v", err)
			}
			completed, err := inference.NewResponseCompletedEvent(
				sequence,
				inference.StopReasonEndTurn,
				"",
				final,
			)
			if err != nil {
				t.Fatalf("NewResponseCompletedEvent() error = %v", err)
			}
			if err := stream.Accept(completed); err != nil {
				t.Fatalf("Accept(completed) error = %v", err)
			}
			usage, ok := stream.Usage()
			if !ok || usage != final {
				t.Fatalf("stream usage = %+v ok=%v, want %+v", usage, ok, final)
			}
		})
	}
}
