package chatruntime

import (
	"strings"
	"sync"
)

// EventListener 接收单条会话事件投递。
type EventListener func(EventEnvelope)

// EventHub 维护内存级会话事件订阅与实时广播。
type EventHub struct {
	mu        sync.RWMutex
	listeners map[string]map[uint64]EventListener
	nextID    uint64
}

// NewEventHub 创建空的会话事件总线。
func NewEventHub() *EventHub {
	return &EventHub{
		listeners: make(map[string]map[uint64]EventListener),
	}
}

// Subscribe 注册指定会话的实时事件监听器，返回幂等取消函数。
func (h *EventHub) Subscribe(sessionID string, listener EventListener) (func(), error) {
	sid := strings.TrimSpace(sessionID)
	if sid == "" {
		return nil, NewError("chat_runtime_event_session_required", 500, nil)
	}
	if listener == nil {
		return nil, NewError("chat_runtime_event_listener_required", 500, nil)
	}

	h.mu.Lock()
	h.nextID++
	id := h.nextID
	bucket := h.listeners[sid]
	if bucket == nil {
		bucket = make(map[uint64]EventListener)
		h.listeners[sid] = bucket
	}
	bucket[id] = listener
	h.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			h.mu.Lock()
			if b := h.listeners[sid]; b != nil {
				delete(b, id)
				if len(b) == 0 {
					delete(h.listeners, sid)
				}
			}
			h.mu.Unlock()
		})
	}, nil
}

// Publish 向当前已注册的会话监听器快照投递事件，并返回接收者数量。
func (h *EventHub) Publish(event EventEnvelope) (int, error) {
	sid := strings.TrimSpace(event.SessionID)
	if sid == "" {
		return 0, NewError("chat_runtime_event_session_required", 500, nil)
	}

	h.mu.RLock()
	bucket := h.listeners[sid]
	snapshot := make([]EventListener, 0, len(bucket))
	for _, fn := range bucket {
		if fn != nil {
			snapshot = append(snapshot, fn)
		}
	}
	h.mu.RUnlock()

	for _, fn := range snapshot {
		func() {
			defer func() { _ = recover() }()
			fn(event)
		}()
	}
	return len(snapshot), nil
}

// ListenerCount 返回会话当前的活跃监听器数量。
func (h *EventHub) ListenerCount(sessionID string) int {
	sid := strings.TrimSpace(sessionID)
	h.mu.RLock()
	n := len(h.listeners[sid])
	h.mu.RUnlock()
	return n
}
