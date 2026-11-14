package chatruntime

import (
	"strings"
	"sync"
)

// CodexClientLease 表示对池中常驻 CodexRPCClient 的借用租约。
type CodexClientLease struct {
	Client  CodexRPCClient
	Release func() bool
}

// CodexClientPool 按 runtimeScope + fingerprint 复用常驻 app-server 客户端。
type CodexClientPool struct {
	mu      sync.Mutex
	entries map[string]*codexPoolEntry
	closed  bool
	factory func(opts CodexAppServerClientOptions) CodexRPCClient
}

type codexPoolEntry struct {
	key    string
	client CodexRPCClient
	refs   int
}

// NewCodexClientPool 构造常驻 Codex app-server 客户端连接池。
func NewCodexClientPool(factory func(opts CodexAppServerClientOptions) CodexRPCClient) *CodexClientPool {
	if factory == nil {
		factory = func(opts CodexAppServerClientOptions) CodexRPCClient {
			return NewCodexAppServerClient(opts)
		}
	}
	return &CodexClientPool{
		entries: make(map[string]*codexPoolEntry),
		factory: factory,
	}
}

// codexResidentClient 仅由真实客户端提供空闲通知；替代实现的租约本身就是所有权。
type codexResidentClient interface {
	retireIfIdle() bool
	setIdleObserver(func())
}

// Acquire 获取或创建作用域租约；最后租约且无活动绑定/释放时立即回收。
func (p *CodexClientPool) Acquire(opts CodexAppServerClientOptions) *CodexClientLease {
	key := strings.TrimSpace(opts.RuntimeScope) + "::" + strings.TrimSpace(opts.RuntimeFingerprint)
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		client := p.factory(opts)
		// 关闭后的池不能创建可连接的新 resident；返回已关闭句柄保持接口兼容。
		_ = client.Close()
		var once sync.Once
		return &CodexClientLease{Client: client, Release: func() bool { released := false; once.Do(func() { released = true }); return released }}
	}
	entry := p.entries[key]
	if entry == nil {
		entry = &codexPoolEntry{key: key, client: p.factory(opts)}
		p.entries[key] = entry
		if resident, ok := entry.client.(codexResidentClient); ok {
			resident.setIdleObserver(func() { p.closeIdle(entry) })
		}
	}
	entry.refs++
	p.mu.Unlock()
	var once sync.Once
	return &CodexClientLease{Client: entry.client, Release: func() bool {
		released := false
		once.Do(func() {
			p.mu.Lock()
			entry.refs--
			p.mu.Unlock()
			released = true
		})
		if released {
			p.closeIdle(entry)
		}
		return released
	}}
}

// closeIdle 在锁内决定所有权，关闭进程在锁外，避免回调/Wait 卡住整个池。
func (p *CodexClientPool) closeIdle(entry *codexPoolEntry) {
	p.mu.Lock()
	if entry.refs > 0 || p.entries[entry.key] != entry {
		p.mu.Unlock()
		return
	}
	if resident, ok := entry.client.(codexResidentClient); ok && !resident.retireIfIdle() {
		p.mu.Unlock()
		return
	}
	delete(p.entries, entry.key)
	p.mu.Unlock()
	_ = entry.client.Close()
}

// Close 释放池中全部常驻客户端。
func (p *CodexClientPool) Close() error {
	p.mu.Lock()
	p.closed = true
	entries := make([]*codexPoolEntry, 0, len(p.entries))
	for k, e := range p.entries {
		entries = append(entries, e)
		delete(p.entries, k)
	}
	p.mu.Unlock()
	for _, e := range entries {
		_ = e.client.Close()
	}
	return nil
}
