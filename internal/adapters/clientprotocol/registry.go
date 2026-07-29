package clientprotocol

import (
	"errors"

	"github.com/madou1217/ai_home/core/inference"
)

var (
	// ErrInvalidAdapter 表示协议 Adapter 缺失或声明了无效协议。
	ErrInvalidAdapter = errors.New("客户端协议 Adapter 无效")
	// ErrDuplicateProtocol 表示同一客户端协议被重复注册。
	ErrDuplicateProtocol = errors.New("客户端协议重复注册")
	// ErrProtocolNotRegistered 表示指定客户端协议尚未注册。
	ErrProtocolNotRegistered = errors.New("客户端协议尚未注册")
)

// StreamRenderer 把 Canonical 事件渲染为客户端 SSE 事件。
type StreamRenderer interface {
	Render(inference.StreamEvent) ([]RenderedEvent, error)
	Terminal() bool
}

// ResponseAggregator 把 Canonical 事件聚合为非流式客户端响应。
type ResponseAggregator interface {
	Add(inference.StreamEvent) error
	Marshal() ([]byte, error)
}

// Adapter 是单一客户端协议的完整请求和响应边界。
type Adapter interface {
	ProtocolID() inference.ClientProtocolID
	Decode([]byte) (inference.Request, error)
	NewStreamRenderer(inference.Request) StreamRenderer
	NewResponseAggregator(inference.Request) ResponseAggregator
}

// Registry 保存按 Canonical ClientProtocolID 注册的不可变 Adapter 集合。
type Registry struct {
	adapters map[inference.ClientProtocolID]Adapter
}

// NewRegistry 创建不允许无效项或重复协议的 Adapter Registry。
func NewRegistry(adapters ...Adapter) (*Registry, error) {
	if len(adapters) == 0 {
		return nil, ErrInvalidAdapter
	}
	registered := make(
		map[inference.ClientProtocolID]Adapter,
		len(adapters),
	)
	for _, adapter := range adapters {
		if adapter == nil {
			return nil, ErrInvalidAdapter
		}
		protocolID := adapter.ProtocolID()
		if !protocolID.IsValid() {
			return nil, ErrInvalidAdapter
		}
		if _, exists := registered[protocolID]; exists {
			return nil, ErrDuplicateProtocol
		}
		registered[protocolID] = adapter
	}
	return &Registry{adapters: registered}, nil
}

// Resolve 返回指定协议的 Adapter，不做默认协议或相邻协议回退。
func (registry *Registry) Resolve(
	protocolID inference.ClientProtocolID,
) (Adapter, error) {
	if registry == nil || !protocolID.IsValid() {
		return nil, ErrProtocolNotRegistered
	}
	adapter, found := registry.adapters[protocolID]
	if !found {
		return nil, ErrProtocolNotRegistered
	}
	return adapter, nil
}
