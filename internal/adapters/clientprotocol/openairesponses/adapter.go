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

// exchange 绑定一次 Responses 请求、Canonical 投影和客户端回显投影。
type exchange struct {
	adapter Adapter
	decoded decodedRequest
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

// Bind 只解析一次请求，并把两种投影限制在当前 Exchange 生命周期内。
func (adapter Adapter) Bind(body []byte) (clientprotocol.Exchange, error) {
	decoded, err := NewRequestDecoder().decode(body)
	if err != nil {
		return nil, err
	}
	return exchange{adapter: adapter, decoded: decoded}, nil
}

// CanonicalRequest 返回供路由与 Provider Adapter 使用的协议中立请求。
func (bound exchange) CanonicalRequest() inference.Request {
	return bound.decoded.canonical
}

// NewStreamRenderer 创建保留当前 Responses 回显投影的 SSE Renderer。
func (bound exchange) NewStreamRenderer() clientprotocol.StreamRenderer {
	createdAt := bound.adapter.clock()
	return newStreamRenderer(
		bound.decoded.canonical,
		bound.decoded.projection,
		createdAt,
		bound.adapter.clock,
	)
}

// NewResponseAggregator 创建保留当前 Responses 回显投影的非流式聚合器。
func (bound exchange) NewResponseAggregator() clientprotocol.ResponseAggregator {
	createdAt := bound.adapter.clock()
	return newResponseAggregator(
		bound.decoded.canonical,
		bound.decoded.projection,
		createdAt,
		bound.adapter.clock,
	)
}

// NewStreamRenderer 创建共享同一生命周期时钟的 Responses SSE Renderer。
func (adapter Adapter) NewStreamRenderer(
	request inference.Request,
) clientprotocol.StreamRenderer {
	createdAt := adapter.clock()
	return newStreamRenderer(
		request,
		defaultResponseProjection(),
		createdAt,
		adapter.clock,
	)
}

// NewResponseAggregator 创建共享同一生命周期时钟的 Responses 非流式聚合器。
func (adapter Adapter) NewResponseAggregator(
	request inference.Request,
) clientprotocol.ResponseAggregator {
	createdAt := adapter.clock()
	return newResponseAggregator(
		request,
		defaultResponseProjection(),
		createdAt,
		adapter.clock,
	)
}
