package codexresponsesws

import (
	"errors"
	"sync"
)

// sessionRegistry 让 Server.Close 能管理 net/http 不再跟踪的 hijacked 连接。
type sessionRegistry struct {
	mu       sync.Mutex
	sessions map[*managedSession]struct{}
	closed   bool
}

func newSessionRegistry() *sessionRegistry {
	return &sessionRegistry{
		sessions: make(map[*managedSession]struct{}),
	}
}

// Add 注册新会话；关闭开始后失败关闭。
func (registry *sessionRegistry) Add(session *managedSession) bool {
	if registry == nil || session == nil {
		return false
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	if registry.closed {
		return false
	}
	registry.sessions[session] = struct{}{}
	return true
}

// Remove 删除已完成会话，不触碰其它连接。
func (registry *sessionRegistry) Remove(session *managedSession) {
	if registry == nil || session == nil {
		return
	}
	registry.mu.Lock()
	delete(registry.sessions, session)
	registry.mu.Unlock()
}

// Closed 返回是否已经开始关闭。
func (registry *sessionRegistry) Closed() bool {
	if registry == nil {
		return true
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	return registry.closed
}

// Close 先原子禁止注册，再在锁外并行安全地关闭快照中的会话。
func (registry *sessionRegistry) Close() error {
	if registry == nil {
		return nil
	}
	registry.mu.Lock()
	if registry.closed {
		registry.mu.Unlock()
		return nil
	}
	registry.closed = true
	sessions := make([]*managedSession, 0, len(registry.sessions))
	for session := range registry.sessions {
		sessions = append(sessions, session)
	}
	registry.sessions = make(map[*managedSession]struct{})
	registry.mu.Unlock()
	closeErrors := make([]error, 0, len(sessions))
	for _, session := range sessions {
		closeErrors = append(closeErrors, session.CloseNow())
	}
	return errors.Join(closeErrors...)
}
