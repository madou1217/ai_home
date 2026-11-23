package proxytransport

import (
	"context"
	"errors"
	"net"
	"sync"
)

// ErrConnectorClosed 表示可重连连接器已经被关闭。
var ErrConnectorClosed = errors.New("proxytransport: connector closed")

// ConnectorFactory 建立一条新的底层连接。
type ConnectorFactory func(ctx context.Context) (Connector, error)

// ReconnectingConnector 在每次拨号失败时重建底层连接，并重试一次。
//
// 它只替换字节流拨号器，不改变本地监听端口；已经建立的隧道不会迁移，
// 但新连接可以在 SSH 短暂断开后恢复。
type ReconnectingConnector struct {
	mu      sync.Mutex
	current Connector
	factory ConnectorFactory
	closed  bool
}

// NewReconnectingConnector 用初始连接和工厂构造可重连拨号器。
func NewReconnectingConnector(initial Connector, factory ConnectorFactory) (*ReconnectingConnector, error) {
	if initial == nil || factory == nil {
		return nil, errors.New("proxytransport: initial connector and factory are required")
	}
	return &ReconnectingConnector{current: initial, factory: factory}, nil
}

// DialTCP 先使用当前连接；失败时关闭旧连接、重建并重试一次。
func (connector *ReconnectingConnector) DialTCP(ctx context.Context, network, address string) (net.Conn, error) {
	if connector == nil {
		return nil, ErrConnectorClosed
	}
	connector.mu.Lock()
	if connector.closed {
		connector.mu.Unlock()
		return nil, ErrConnectorClosed
	}
	current := connector.current
	connector.mu.Unlock()
	if current == nil {
		return connector.reconnectAndDial(ctx, network, address, nil)
	}
	connection, err := current.DialTCP(ctx, network, address)
	if err == nil {
		return connection, nil
	}
	return connector.reconnectAndDial(ctx, network, address, current)
}

func (connector *ReconnectingConnector) reconnectAndDial(ctx context.Context, network, address string, failed Connector) (net.Conn, error) {
	connector.mu.Lock()
	defer connector.mu.Unlock()
	if connector.closed {
		return nil, ErrConnectorClosed
	}
	if connector.current != failed && connector.current != nil {
		// 另一个调用已经完成了重连，直接使用新连接。
		return connector.current.DialTCP(ctx, network, address)
	}
	if connector.current != nil {
		_ = connector.current.Close()
		connector.current = nil
	}
	replacement, err := connector.factory(ctx)
	if err != nil {
		return nil, err
	}
	connector.current = replacement
	return replacement.DialTCP(ctx, network, address)
}

// Close 关闭当前连接并阻止后续重连；幂等。
func (connector *ReconnectingConnector) Close() error {
	if connector == nil {
		return nil
	}
	connector.mu.Lock()
	if connector.closed {
		connector.mu.Unlock()
		return nil
	}
	connector.closed = true
	current := connector.current
	connector.current = nil
	connector.mu.Unlock()
	if current != nil {
		return current.Close()
	}
	return nil
}
