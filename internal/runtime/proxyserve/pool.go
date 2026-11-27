package proxyserve

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"strings"
	"sync"
)

// Pool owns one single-entry Manager per selector. It lets the app desk run
// several temporary entries side by side (for example one app on us,jp and
// another on a specific node) while each Manager keeps the existing lifecycle,
// JSON handshake, and cleanup semantics.
type Pool struct {
	options Options

	mu      sync.Mutex
	entries map[string]*Manager
}

// NewPool creates a pool with the same CLI/server/key options as Manager.
func NewPool(options Options) *Pool {
	return &Pool{options: options, entries: make(map[string]*Manager)}
}

// Ensure returns a running entry for selector, starting one on a random local
// port when needed. Calls are serialized: app launches are rare and a partially
// started pool must not hand out two entries for the same selector.
func (pool *Pool) Ensure(ctx context.Context, selector string) (View, error) {
	selector = strings.TrimSpace(selector)
	if selector == "" {
		return View{}, ErrSelectorInvalid
	}
	pool.mu.Lock()
	defer pool.mu.Unlock()
	// Reuse any live entry for this selector: two apps asking for the same
	// region can share one upstream/port.
	for key, manager := range pool.entries {
		if !strings.HasPrefix(key, selector+"|") {
			continue
		}
		view := manager.View()
		if view.Running && view.HTTPURL != "" {
			return view, nil
		}
		delete(pool.entries, key)
		_ = manager.Stop(context.Background())
	}
	port, portErr := freePort()
	if portErr != nil {
		return View{}, portErr
	}
	manager := NewManager(pool.options)
	view, err := manager.Start(ctx, Request{
		Selector: selector,
		NoSocks:  true,
		HTTPPort: port,
	})
	if err != nil {
		return View{}, err
	}
	pool.entries[fmt.Sprintf("%s|%d", selector, port)] = manager
	return view, nil
}

// freePort reserves an OS-assigned port. Passing the concrete port to the CLI
// (instead of 0) keeps the listener stable across self-heal rebuilds: apps were
// launched with --proxy-server=127.0.0.1:<port> and cannot follow a new one.
func freePort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	address, ok := listener.Addr().(*net.TCPAddr)
	_ = listener.Close()
	if !ok || address.Port <= 0 {
		return 0, fmt.Errorf("无法分配本地代理端口")
	}
	return address.Port, nil
}

// RestartOnPort stops the pooled entry bound to port and starts a fresh one
// with the same selector. Manual "reconnect" must force a new lease: a
// listening port can still serve 502/403 when its lease went stale.
func (pool *Pool) RestartOnPort(ctx context.Context, selector string, port int) (View, error) {
	pool.mu.Lock()
	managers := make([]*Manager, 0, 1)
	for key, manager := range pool.entries {
		view := manager.View()
		if view.Running && portOf(view.HTTPURL) == port {
			managers = append(managers, manager)
			delete(pool.entries, key)
		}
	}
	pool.mu.Unlock()
	for _, manager := range managers {
		_ = manager.Stop(context.Background())
	}
	return pool.EnsureOnPort(ctx, selector, port)
}

// EnsureOnPort restarts (or returns) the entry for selector on an existing
// port. Manual reconnect must keep the port: an already-running browser was
// launched with --proxy-server=127.0.0.1:<port>, and a new random port would
// leave it pointing at a dead endpoint.
func (pool *Pool) EnsureOnPort(ctx context.Context, selector string, port int) (View, error) {
	if port <= 0 {
		return pool.Ensure(ctx, selector)
	}
	selector = strings.TrimSpace(selector)
	if selector == "" {
		return View{}, ErrSelectorInvalid
	}
	key := fmt.Sprintf("%s|%d", selector, port)
	pool.mu.Lock()
	defer pool.mu.Unlock()
	for existingKey, manager := range pool.entries {
		view := manager.View()
		if view.Running && portOf(view.HTTPURL) == port {
			if existingKey == key {
				return view, nil
			}
			delete(pool.entries, existingKey)
			_ = manager.Stop(context.Background())
		}
	}
	if manager := pool.entries[key]; manager != nil {
		view := manager.View()
		if view.Running && view.HTTPURL != "" {
			return view, nil
		}
		delete(pool.entries, key)
		_ = manager.Stop(context.Background())
	}
	manager := NewManager(pool.options)
	view, err := manager.Start(ctx, Request{
		Selector:  selector,
		NoSocks:   true,
		HTTPPort:  port,
		SocksPort: 0,
	})
	if err != nil {
		return View{}, err
	}
	pool.entries[key] = manager
	return view, nil
}

func portOf(rawURL string) int {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed == nil || parsed.Port() == "" {
		return 0
	}
	port := 0
	_, _ = fmt.Sscanf(parsed.Port(), "%d", &port)
	return port
}

// Stop terminates the entry for selector. Missing entries are a no-op.
func (pool *Pool) Stop(selector string) {
	selector = strings.TrimSpace(selector)
	pool.mu.Lock()
	managers := make([]*Manager, 0, 1)
	for key, manager := range pool.entries {
		if key == selector || strings.HasPrefix(key, selector+"|") {
			managers = append(managers, manager)
			delete(pool.entries, key)
		}
	}
	pool.mu.Unlock()
	for _, manager := range managers {
		_ = manager.Stop(context.Background())
	}
}

// StopAll terminates every temporary entry owned by the pool.
func (pool *Pool) StopAll() {
	pool.mu.Lock()
	managers := make([]*Manager, 0, len(pool.entries))
	for selector, manager := range pool.entries {
		managers = append(managers, manager)
		delete(pool.entries, selector)
	}
	pool.mu.Unlock()
	for _, manager := range managers {
		_ = manager.Stop(context.Background())
	}
}
