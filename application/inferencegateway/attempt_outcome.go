package inferencegateway

// attemptOutcome 描述单次上游调用对编排的影响。
//
// stream 始终非空，即使调用以内部故障结束。编排层据此判断客户端是否已经看到
// 本次调用的事件：只有一个字节都没写出去时，补发更早记录的真实上游失败才是安全的。
type attemptOutcome struct {
	stream *attemptStream
	retry  bool
}

// newAttemptOutcome 创建保留事件边界的调用结果。
func newAttemptOutcome(
	stream *attemptStream,
	retry bool,
) attemptOutcome {
	return attemptOutcome{stream: stream, retry: retry}
}

// Visible 表示本次调用已经向客户端写出至少一个事件。
func (outcome attemptOutcome) Visible() bool {
	return outcome.stream.Visible()
}
