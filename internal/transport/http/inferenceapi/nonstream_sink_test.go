package inferenceapi

import (
	"errors"
	"testing"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
)

// recordingAggregator 记录真正落到 Canonical 聚合器上的事件。
type recordingAggregator struct {
	events []inference.StreamEvent
	addErr error
}

func (aggregator *recordingAggregator) Add(
	event inference.StreamEvent,
) error {
	if aggregator.addErr != nil {
		return aggregator.addErr
	}
	aggregator.events = append(aggregator.events, event)
	return nil
}

func (aggregator *recordingAggregator) Marshal() ([]byte, error) {
	return []byte("{}"), nil
}

// newRateLimitFailedEvent 构造上游限流在第一个字节之前失败时的 Canonical 终态。
func newRateLimitFailedEvent(
	t *testing.T,
	sequence uint64,
) inference.ResponseFailedEvent {
	t.Helper()
	failure, err := inference.NewResponseFailure(
		string(runtimecore.FailureRateLimited),
		"Please retry later",
		true,
	)
	if err != nil {
		t.Fatalf("NewResponseFailure() error = %v", err)
	}
	failed, err := inference.NewResponseFailedEvent(sequence, failure)
	if err != nil {
		t.Fatalf("NewResponseFailedEvent() error = %v", err)
	}
	return failed
}

// TestNonStreamSinkCarriesPreCommitFailureOutsideAggregator 验证启动前失败被单独
// 承载：聚合器一个事件都收不到，调用方因此拿得到真实上游失败分类而不是序号错误。
func TestNonStreamSinkCarriesPreCommitFailureOutsideAggregator(t *testing.T) {
	t.Parallel()

	aggregator := &recordingAggregator{}
	sink := NewNonStreamSink(aggregator)
	if err := sink.Accept(newRateLimitFailedEvent(t, 0)); err != nil {
		t.Fatalf("Accept() error = %v", err)
	}
	if len(aggregator.events) != 0 {
		t.Fatalf("聚合器收到了启动前失败事件: %#v", aggregator.events)
	}
	failure, failed := sink.Failure()
	if !failed ||
		failure.Code() != string(runtimecore.FailureRateLimited) ||
		sink.Err() != nil {
		t.Fatalf(
			"failure = %#v failed = %v err = %v",
			failure,
			failed,
			sink.Err(),
		)
	}
}

// TestNonStreamSinkRejectsPreCommitFailureWithNonZeroSequence 验证只有序号为 0 的
// 启动前失败合法：任何其它序号说明事件流已被破坏，必须暴露为无效上游响应。
func TestNonStreamSinkRejectsPreCommitFailureWithNonZeroSequence(t *testing.T) {
	t.Parallel()

	aggregator := &recordingAggregator{}
	sink := NewNonStreamSink(aggregator)
	err := sink.Accept(newRateLimitFailedEvent(t, 1))
	if !errors.Is(err, ErrInvalidPreCommitFailure) ||
		!errors.Is(sink.Err(), ErrInvalidPreCommitFailure) {
		t.Fatalf("Accept() error = %v sink.Err() = %v", err, sink.Err())
	}
	if _, failed := sink.Failure(); failed {
		t.Fatal("非法启动前失败不应被承载为终态")
	}
}

// TestNonStreamSinkRejectsEventAfterTerminal 验证终态之后不再接受任何事件。
func TestNonStreamSinkRejectsEventAfterTerminal(t *testing.T) {
	t.Parallel()

	aggregator := &recordingAggregator{}
	sink := NewNonStreamSink(aggregator)
	if err := sink.Accept(newRateLimitFailedEvent(t, 0)); err != nil {
		t.Fatalf("Accept() error = %v", err)
	}
	started, err := inference.NewResponseStartedEvent(
		1,
		"resp_after_terminal",
		"gpt-5.6-sol",
	)
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	if err := sink.Accept(started); !errors.Is(
		err,
		ErrInvalidPreCommitFailure,
	) {
		t.Fatalf("Accept() error = %v", err)
	}
	if len(aggregator.events) != 0 {
		t.Fatalf("终态之后的事件仍然进了聚合器: %#v", aggregator.events)
	}
}

// TestNonStreamSinkForwardsNormalEventsToAggregator 验证正常事件仍然原样交给
// 聚合器，装饰器不改变成功路径语义。
func TestNonStreamSinkForwardsNormalEventsToAggregator(t *testing.T) {
	t.Parallel()

	aggregator := &recordingAggregator{}
	sink := NewNonStreamSink(aggregator)
	started, err := inference.NewResponseStartedEvent(
		0,
		"resp_forward",
		"gpt-5.6-sol",
	)
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	if err := sink.Accept(started); err != nil {
		t.Fatalf("Accept() error = %v", err)
	}
	if len(aggregator.events) != 1 || sink.Err() != nil {
		t.Fatalf(
			"events = %#v err = %v",
			aggregator.events,
			sink.Err(),
		)
	}
	if _, failed := sink.Failure(); failed {
		t.Fatal("成功事件不应产生失败终态")
	}
}

// TestNonStreamSinkRejectsMissingAggregator 验证缺少聚合器时立即暴露依赖错误，
// 而不是静默吞掉事件。
func TestNonStreamSinkRejectsMissingAggregator(t *testing.T) {
	t.Parallel()

	sink := NewNonStreamSink(nil)
	if err := sink.Accept(newRateLimitFailedEvent(t, 0)); !errors.Is(
		err,
		ErrInvalidAggregator,
	) {
		t.Fatalf("Accept() error = %v", err)
	}
}
