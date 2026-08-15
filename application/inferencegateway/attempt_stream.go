package inferencegateway

import (
	"time"

	"github.com/madou1217/ai_home/core/inference"
)

// attemptStream 顺序转发非终态并暂存唯一终态。
type attemptStream struct {
	emit         EventSink
	visible      bool
	hasSequence  bool
	lastSequence uint64
	terminal     inference.StreamEvent
	terminalAt   time.Time
	clock        func() time.Time
	err          error
}

// newAttemptStream 创建同步传播背压的单次调用事件边界。
func newAttemptStream(emit EventSink, clock func() time.Time) *attemptStream {
	return &attemptStream{emit: emit, clock: clock}
}

// Accept 校验连续序号，立即转发非终态并暂存终态。
func (stream *attemptStream) Accept(
	event inference.StreamEvent,
) error {
	if stream.err != nil {
		return stream.err
	}
	if event == nil || stream.terminal != nil {
		stream.err = ErrInvalidUpstreamEventStream
		return stream.err
	}
	if !stream.validSequence(event.Sequence()) {
		stream.err = ErrInvalidUpstreamEventStream
		return stream.err
	}
	stream.hasSequence = true
	stream.lastSequence = event.Sequence()
	switch event.Kind() {
	case inference.EventResponseCompleted,
		inference.EventResponseFailed:
		if stream.clock == nil {
			stream.err = ErrInvalidUpstreamEventStream
			return stream.err
		}
		stream.terminal = event
		stream.terminalAt = stream.clock()
		return nil
	default:
		if err := stream.emit(event); err != nil {
			stream.err = err
			return err
		}
		stream.visible = true
		return nil
	}
}

// TerminalAt 返回上游终态进入 Coordinator 的发生时间。
func (stream *attemptStream) TerminalAt() time.Time {
	if stream == nil {
		return time.Time{}
	}
	return stream.terminalAt
}

// Visible 表示至少一个非终态事件已经交给客户端。
func (stream *attemptStream) Visible() bool {
	return stream != nil && stream.visible
}

// Completed 表示 Adapter 返回了成功终态。
func (stream *attemptStream) Completed() bool {
	return stream != nil &&
		stream.terminal != nil &&
		stream.terminal.Kind() == inference.EventResponseCompleted
}

// FailedWithDifferent 判断 Adapter 失败终态与结果分类是否矛盾。
func (stream *attemptStream) FailedWithDifferent(
	failure inference.ResponseFailure,
) bool {
	if stream == nil ||
		stream.terminal == nil ||
		stream.terminal.Kind() != inference.EventResponseFailed {
		return false
	}
	event, ok := stream.terminal.(inference.ResponseFailedEvent)
	if !ok {
		return true
	}
	return !sameResponseFailure(event.Failure(), failure)
}

// EnsureFailure 在 Adapter 未产生失败终态时补充连续序号事件。
func (stream *attemptStream) EnsureFailure(
	failure inference.ResponseFailure,
) error {
	if stream == nil || !failure.IsValid() {
		return ErrInvalidUpstreamEventStream
	}
	if stream.terminal != nil {
		if stream.terminal.Kind() != inference.EventResponseFailed ||
			stream.FailedWithDifferent(failure) {
			return ErrInvalidUpstreamEventStream
		}
		return nil
	}
	sequence := uint64(0)
	if stream.hasSequence {
		sequence = stream.lastSequence + 1
	}
	event, err := inference.NewResponseFailedEvent(sequence, failure)
	if err != nil {
		return ErrInvalidUpstreamEventStream
	}
	stream.terminal = event
	stream.hasSequence = true
	stream.lastSequence = sequence
	return nil
}

// FlushTerminal 在状态记录成功后向客户端提交唯一终态。
func (stream *attemptStream) FlushTerminal() error {
	if stream == nil || stream.terminal == nil || stream.err != nil {
		return ErrInvalidUpstreamEventStream
	}
	if err := stream.emit(stream.terminal); err != nil {
		stream.err = err
		return err
	}
	stream.visible = true
	return nil
}

// Err 返回同步输出端口的首个错误。
func (stream *attemptStream) Err() error {
	if stream == nil {
		return ErrInvalidUpstreamEventStream
	}
	return stream.err
}

// validSequence 要求每次上游调用从零开始并严格连续。
func (stream *attemptStream) validSequence(sequence uint64) bool {
	if !stream.hasSequence {
		return sequence == 0
	}
	return stream.lastSequence != ^uint64(0) &&
		sequence == stream.lastSequence+1
}

// sameResponseFailure 比较不包含 Provider 原文的安全失败值。
func sameResponseFailure(
	left inference.ResponseFailure,
	right inference.ResponseFailure,
) bool {
	return left.Code() == right.Code() &&
		left.SafeMessage() == right.SafeMessage() &&
		left.Retryable() == right.Retryable()
}
