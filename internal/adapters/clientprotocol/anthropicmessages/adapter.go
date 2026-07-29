package anthropicmessages

import (
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
)

// Adapter 把 Anthropic Messages Decoder 和两种 Renderer 注册为统一协议策略。
type Adapter struct {
	decoder RequestDecoder
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
