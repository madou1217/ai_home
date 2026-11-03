package anthropicmessages

import (
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
)

// Adapter 把 Anthropic Messages Decoder 和两种 Renderer 注册为统一协议策略。
type Adapter struct {
	decoder RequestDecoder
}

// exchange 绑定一次 Messages 请求及其无共享状态的响应策略。
type exchange struct {
	adapter Adapter
	request inference.Request
}

// NewAdapter 创建无状态、可并发复用的 Anthropic Messages Adapter。
func NewAdapter() Adapter {
	return Adapter{decoder: NewRequestDecoder()}
}

// ProtocolID 返回 Messages 的 Canonical 客户端协议身份。
func (Adapter) ProtocolID() inference.ClientProtocolID {
	return inference.ClientProtocolAnthropicMessages
}

// Decode 把完整 Messages JSON 请求转换为 Canonical Request。
func (adapter Adapter) Decode(body []byte) (inference.Request, error) {
	return adapter.decoder.Decode(body)
}

// Bind 解析一次请求，并把 Canonical Request 与本协议 Renderer 绑定。
func (adapter Adapter) Bind(body []byte) (clientprotocol.Exchange, error) {
	request, err := adapter.Decode(body)
	if err != nil {
		return nil, err
	}
	return exchange{adapter: adapter, request: request}, nil
}

// CanonicalRequest 返回供路由与 Provider Adapter 使用的协议中立请求。
func (bound exchange) CanonicalRequest() inference.Request {
	return bound.request
}

// NewStreamRenderer 创建当前请求独占的 Messages SSE Renderer。
func (bound exchange) NewStreamRenderer() clientprotocol.StreamRenderer {
	return bound.adapter.NewStreamRenderer(bound.request)
}

// NewResponseAggregator 创建当前请求独占的 Messages 聚合器。
func (bound exchange) NewResponseAggregator() clientprotocol.ResponseAggregator {
	return bound.adapter.NewResponseAggregator(bound.request)
}

// NewStreamRenderer 创建本次响应独占的 Messages SSE Renderer。
func (Adapter) NewStreamRenderer(
	request inference.Request,
) clientprotocol.StreamRenderer {
	return NewStreamRenderer(request)
}

// NewResponseAggregator 创建本次响应独占的 Messages 非流式聚合器。
func (Adapter) NewResponseAggregator(
	request inference.Request,
) clientprotocol.ResponseAggregator {
	return NewResponseAggregator(request)
}
