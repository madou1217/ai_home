package inferenceapi

import (
	"errors"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
)

var (
	// ErrInvalidPreCommitFailure 表示启动前失败事件违反 Canonical 序号或值合同。
	ErrInvalidPreCommitFailure = errors.New("提交前 Canonical 失败事件无效")
	// ErrInvalidAggregator 表示非流式 Sink 缺少必需的聚合器。
	ErrInvalidAggregator = errors.New("非流式 Canonical 聚合器无效")
)

// NonStreamSink 在聚合器之前拦截「启动前失败」，保住上游真实状态码。
//
// Canonical 状态机要求首个事件必须是序号为 0 的 ResponseStartedEvent。上游在第一个
// 字节之前失败时（429/401/403/404 等），Adapter 不会发出任何事件，Coordinator 只能
// 补一个序号为 0 的 ResponseFailedEvent。该事件一旦直接交给聚合器，会被状态机判成
// 序号非法，调用方于是把上游真实状态码改写成 502，客户端拿到的重试语义完全相反。
//
// 这个装饰器只做一件事：把启动前失败从聚合链路上摘下来单独承载，聚合器因此永远
// 只看到合法事件序列，真实失败由调用方按 Canonical 失败码映射为对外状态码。
type NonStreamSink struct {
	aggregator clientprotocol.ResponseAggregator
	failure    inference.ResponseFailure
	failed     bool
	observed   bool
	err        error
}

// NewNonStreamSink 包装单次非流式请求的 Canonical 聚合器。
func NewNonStreamSink(
	aggregator clientprotocol.ResponseAggregator,
) *NonStreamSink {
	return &NonStreamSink{aggregator: aggregator}
}

// Accept 是交给 Executor 的 EventSink，按 Canonical 事件合同逐个校验并分派。
func (sink *NonStreamSink) Accept(event inference.StreamEvent) error {
	if sink == nil || sink.aggregator == nil {
		return ErrInvalidAggregator
	}
	if sink.err != nil {
		return sink.err
	}
	eventFailure, isFailure := event.(inference.ResponseFailedEvent)
	if isFailure && !sink.observed {
		// 启动前失败：整条流只有这一个事件，交给聚合器必然被判非法。
		failure := eventFailure.Failure()
		if event.Sequence() != 0 || !failure.IsValid() {
			sink.err = ErrInvalidPreCommitFailure
			return sink.err
		}
		sink.failure = failure
		sink.failed = true
		sink.observed = true
		return nil
	}
	if sink.failed {
		// 终态之后不允许再出现任何事件。
		sink.err = ErrInvalidPreCommitFailure
		return sink.err
	}
	if isFailure {
		sink.failure = eventFailure.Failure()
		sink.failed = true
	}
	sink.observed = true
	if err := sink.aggregator.Add(event); err != nil {
		sink.err = err
		return err
	}
	return nil
}

// Failure 返回本次请求已承载的 Canonical 失败终态。
func (sink *NonStreamSink) Failure() (inference.ResponseFailure, bool) {
	if sink == nil || !sink.failed {
		return inference.ResponseFailure{}, false
	}
	return sink.failure, true
}

// Err 返回导致事件序列中止的错误，nil 表示序列合法。
func (sink *NonStreamSink) Err() error {
	if sink == nil {
		return nil
	}
	return sink.err
}
