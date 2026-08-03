package openairesponses

import (
	"encoding/json"
	"time"

	"github.com/madou1217/ai_home/core/inference"
)

// ResponseAggregator 将 Canonical Event Stream 聚合为一个非流式 Responses 响应。
//
// 它与 StreamRenderer 复用同一个 responseState，避免两条输出路径各自解释事件。
type ResponseAggregator struct {
	state *responseState
}

// NewResponseAggregator 创建固定响应创建时间的非流式聚合器。
func NewResponseAggregator(
	request inference.Request,
	createdAt time.Time,
) *ResponseAggregator {
	return &ResponseAggregator{
		state: newResponseState(request, createdAt),
	}
}

// Add 按严格连续序号把一个 Canonical 事件加入聚合状态。
func (aggregator *ResponseAggregator) Add(event inference.StreamEvent) error {
	if err := validateSupportedResponseEvent(event); err != nil {
		return err
	}
	return aggregator.state.apply(event)
}

// Marshal 只在收到明确成功终态后编码完整 Responses 对象。
func (aggregator *ResponseAggregator) Marshal() ([]byte, error) {
	switch {
	case aggregator.state.hasFailure:
		return nil, ErrResponseFailed
	case !aggregator.state.completed:
		return nil, ErrResponseNotCompleted
	}
	response, err := aggregator.state.buildResponseWire("completed")
	if err != nil {
		return nil, err
	}
	return json.Marshal(response)
}
