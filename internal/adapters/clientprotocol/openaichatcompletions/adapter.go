package openaichatcompletions

import (
	"time"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
)

// Adapter 把 Chat Decoder 和两种 Renderer 注册为统一协议策略。
type Adapter struct {
	clock func() time.Time
}

// exchange 绑定一次 Chat 请求与对应 Renderer Factory。
type exchange struct {
	adapter Adapter
	request inference.Request
}

// NewAdapter 创建从注入时钟读取响应创建时间的 Chat Adapter。
func NewAdapter(clock func() time.Time) (Adapter, error) {
	if clock == nil {
		return Adapter{}, clientprotocol.ErrInvalidAdapter
	}
	return Adapter{clock: clock}, nil
}

// ProtocolID 返回 Chat Completions 的 Canonical 客户端协议身份。
func (Adapter) ProtocolID() inference.ClientProtocolID {
	return inference.ClientProtocolOpenAIChatCompletions
}

// Decode 把完整 Chat JSON 请求转换为 Canonical Request。
func (Adapter) Decode(body []byte) (inference.Request, error) {
	return NewRequestDecoder().Decode(body)
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

// NewStreamRenderer 创建当前请求独占的 Chat SSE Renderer。
func (bound exchange) NewStreamRenderer() clientprotocol.StreamRenderer {
	return bound.adapter.NewStreamRenderer(bound.request)
}

// NewResponseAggregator 创建当前请求独占的 Chat 聚合器。
func (bound exchange) NewResponseAggregator() clientprotocol.ResponseAggregator {
	return bound.adapter.NewResponseAggregator(bound.request)
}

// NewStreamRenderer 创建固定响应创建时间的 Chat SSE Renderer。
func (adapter Adapter) NewStreamRenderer(
	request inference.Request,
) clientprotocol.StreamRenderer {
	return NewStreamRenderer(request, adapter.clock())
}

// NewResponseAggregator 创建固定响应创建时间的 Chat 非流式聚合器。
func (adapter Adapter) NewResponseAggregator(
	request inference.Request,
) clientprotocol.ResponseAggregator {
	return NewResponseAggregator(request, adapter.clock())
}
