package openairesponses

import (
	"time"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
)

// Adapter 把 OpenAI Responses Decoder 和 Renderer 注册为统一协议策略。
type Adapter struct {
	clock func() time.Time
}

// NewAdapter 创建从注入时钟读取响应创建和完成时间的 Responses Adapter。
func NewAdapter(clock func() time.Time) (Adapter, error) {
	if clock == nil {
		return Adapter{}, clientprotocol.ErrInvalidAdapter
	}
	return Adapter{clock: clock}, nil
}

// ProtocolID 返回 Responses 的 Canonical 客户端协议身份。
func (Adapter) ProtocolID() inference.ClientProtocolID {
	return inference.ClientProtocolOpenAIResponses
}

// Decode 把完整 Responses JSON 请求转换为 Canonical Request。
func (Adapter) Decode(body []byte) (inference.Request, error) {
	return NewRequestDecoder().Decode(body)
}

// NewStreamRenderer 创建共享同一生命周期时钟的 Responses SSE Renderer。
func (adapter Adapter) NewStreamRenderer(
	request inference.Request,
) clientprotocol.StreamRenderer {
	createdAt := adapter.clock()
	return newStreamRenderer(request, createdAt, adapter.clock)
}

// NewResponseAggregator 创建共享同一生命周期时钟的 Responses 非流式聚合器。
func (adapter Adapter) NewResponseAggregator(
	request inference.Request,
) clientprotocol.ResponseAggregator {
	createdAt := adapter.clock()
	return newResponseAggregator(request, createdAt, adapter.clock)
}
