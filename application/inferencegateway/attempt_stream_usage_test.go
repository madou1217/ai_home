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
