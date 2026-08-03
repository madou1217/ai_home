package openaichatcompletions

import (
	"encoding/json"
	"time"

	"github.com/madou1217/ai_home/core/inference"
)

// ResponseAggregator 将 Canonical Event Stream 聚合为一个非流式 Chat Completion。
//
// 它与 StreamRenderer 复用同一个 responseState，避免两条输出路径分别解释事件。
type ResponseAggregator struct {
	state *responseState
}

// NewResponseAggregator 创建固定响应创建时间的非流式聚合器。
func NewResponseAggregator(
	request inference.Request,
	createdAt time.Time,
) *ResponseAggregator {
	return &ResponseAggregator{state: newResponseState(request, createdAt)}
}

// Add 按严格连续序号把一个 Canonical 事件加入聚合状态。
func (aggregator *ResponseAggregator) Add(event inference.StreamEvent) error {
	if err := validateSupportedResponseEvent(event); err != nil {
		return err
	}
	return aggregator.state.apply(event)
}

// Marshal 只在收到明确成功终态后编码完整 Chat Completion。
func (aggregator *ResponseAggregator) Marshal() ([]byte, error) {
	switch {
	case aggregator.state.hasFailure:
		return nil, ErrResponseFailed
	case !aggregator.state.completed:
		return nil, ErrResponseNotCompleted
	}
	response, err := aggregator.state.buildCompletionWire()
	if err != nil {
		return nil, err
	}
	return json.Marshal(response)
}

// validateSupportedResponseEvent 在修改状态前拒绝无法无损表达的事件。
func validateSupportedResponseEvent(event inference.StreamEvent) error {
	switch typed := event.(type) {
	case inference.ReasoningCompletedEvent:
		kind := typed.Content().ReasoningKind()
		if kind != inference.ReasoningSummary &&
			kind != inference.ReasoningThinking {
			return ErrUnsupportedResponseEvent
		}
	case inference.ResponseCompletedEvent:
		if _, err := mapFinishReason(typed.StopReason()); err != nil {
			return err
		}
	}
	return nil
}
