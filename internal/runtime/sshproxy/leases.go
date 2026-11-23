package sshproxy

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/egress"
	"github.com/madou1217/ai_home/internal/runtime/managedproxy"
	"github.com/madou1217/ai_home/internal/runtime/proxypoollease"
)

// LeaseTTL 是单次任务代理租约的默认有效期；客户端应在到期前续租。
const LeaseTTL = 3 * time.Hour

// LeaseManager owns task ingress, never changes a pool's selected global node.
type LeaseManager struct {
	ssh      *Supervisor
	home     string
	pool     *egress.Manager
	mu       sync.Mutex
	leases   map[string]*lease
	closed   bool
	root     context.Context
	cancel   context.CancelFunc
	pending  map[uint64]context.CancelFunc
	sequence uint64
}
type LeaseView struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	ProxyURL string `json:"proxyUrl"`
}
type lease struct {
	view     LeaseView
	listener net.Listener
	server   *http.Server
	sockets  map[net.Conn]bool
	timer    *time.Timer
	cleanup  func()
	closing  bool
}

// engineProvider 只在池管理器真实存在时暴露插件集合，避免 typed-nil 进入接口。
func (m *LeaseManager) engineProvider() proxypoollease.EngineProvider {
	if m == nil || m.pool == nil {
		return nil
	}
	return m.pool
}

func NewLeaseManager(ssh *Supervisor, home string, pool *egress.Manager) *LeaseManager {
	root, cancel := context.WithCancel(context.Background())
	manager := &LeaseManager{ssh: ssh, home: home, pool: pool, leases: map[string]*lease{}, root: root, cancel: cancel, pending: map[uint64]context.CancelFunc{}}
	if ssh != nil {
		ssh.onClose(manager.Close)
	}
	return manager
}
func (m *LeaseManager) Candidates() []Candidate {
	result := []Candidate{}
	if m.ssh != nil {
		result = m.ssh.Candidates()
	}
	nodes, _ := egress.ReadProxyPoolNodes(m.home)
	for _, node := range nodes {
		if node.Raw["managedBy"] == "sshproxy" {
			continue
		}
		available := node.Protocol == "http" || node.Protocol == "https" || node.Protocol == "socks5" || node.Protocol == "socks5h" || proxypoollease.Available(m.engineProvider())
		item := Candidate{ID: node.ID, Name: node.Name, Source: "pool", Available: available}
		if !available {
			item.Error = "此协议需要已安装的代理内核"
		}
		result = append(result, item)
	}
	if m.pool != nil && m.pool.IsPoolReady() {
		result = append(result, Candidate{ID: "pool", Name: "当前代理池", Source: "pool", Available: true})
	}
	sort.SliceStable(result, func(i, j int) bool {
		if result[i].Source != result[j].Source {
			return result[i].Source == "ssh"
		}
		return result[i].ID < result[j].ID
	})
	return result
}
func (m *LeaseManager) dialer(ctx context.Context, selector string) (managedproxy.Dialer, string, func(), error) {
	candidates := m.Candidates()
	selected := selector
	if selector == "" || selector == "auto" {
		selected = ""
		for _, c := range candidates {
			if c.Available {
				selected = c.ID
				break
			}
		}
		if selected == "" {
			return nil, "", func() {}, fmt.Errorf("代理池中没有可用出口；请在 SSH 主机中启用作为代理并等待连接")
		}
	}
	var item *Candidate
	for i := range candidates {
		if candidates[i].ID == selected {
			item = &candidates[i]
			break
		}
	}
	if item == nil || !item.Available {
		return nil, "", func() {}, fmt.Errorf("指定代理不存在或未就绪")
	}
	if strings.HasPrefix(selected, "ssh:") {
		id := strings.TrimPrefix(selected, "ssh:")
		return func(ctx context.Context, _, address string) (net.Conn, error) { return m.ssh.Dial(ctx, id, address) }, item.Name, func() {}, nil
	}
	var proxy *url.URL
	if selected == "pool" {
		state, _ := egress.ReadLivePoolState(m.home, nil)
		if state == nil {
			return nil, "", func() {}, fmt.Errorf("代理池未就绪")
		}
		proxy, _ = url.Parse(state.ProxyURL)
	} else {
		nodes, _ := egress.ReadProxyPoolNodes(m.home)
		for _, node := range nodes {
			if node.ID == selected {
				if node.Protocol != "http" && node.Protocol != "https" && node.Protocol != "socks5" && node.Protocol != "socks5h" {
					runtime, err := proxypoollease.Start(ctx, m.home, node, m.engineProvider())
					if err != nil {
						return nil, "", func() {}, fmt.Errorf("所选代理内核启动失败")
					}
					proxy, _ = url.Parse(runtime.ProxyURL())
					return func(ctx context.Context, _, address string) (net.Conn, error) {
						return managedproxy.ProxyDial(ctx, proxy, address)
					}, item.Name, func() { _ = runtime.Close() }, nil
				}
				proxy = &url.URL{Scheme: node.Protocol, Host: net.JoinHostPort(node.Server, fmt.Sprint(node.Port))}
				if node.Username != "" || node.Password != "" {
					proxy.User = url.UserPassword(node.Username, node.Password)
				}
				break
			}
		}
	}
	if proxy == nil {
		return nil, "", func() {}, fmt.Errorf("代理入口不可用")
	}
	return func(ctx context.Context, _, address string) (net.Conn, error) {
		if proxy.Scheme == "socks5" || proxy.Scheme == "socks5h" {
			return managedproxy.SOCKSDial(ctx, proxy, address)
		}
		return managedproxy.ProxyDial(ctx, proxy, address)
	}, item.Name, func() {}, nil
}
func (m *LeaseManager) Acquire(ctx context.Context, selector string) (LeaseView, error) {
	m.mu.Lock()
	if m.closed || len(m.leases)+len(m.pending) >= 64 {
		m.mu.Unlock()
		return LeaseView{}, fmt.Errorf("代理任务已满或管理器已关闭")
	}
	lifetime, cancel := context.WithCancel(m.root)
	m.sequence++
	reservation := m.sequence
	m.pending[reservation] = cancel
	m.mu.Unlock()
	stopRequestCancellation := context.AfterFunc(ctx, cancel)
	accepted := false
	defer func() {
		stopRequestCancellation()
		m.mu.Lock()
		delete(m.pending, reservation)
		m.mu.Unlock()
		if !accepted {
			cancel()
		}
	}()
	dial, name, cleanup, err := m.dialer(lifetime, selector)
	if err != nil {
		return LeaseView{}, err
	}
	retained := false
	defer func() {
		if !retained {
			cleanup()
		}
	}()
	if err = ctx.Err(); err != nil {
		return LeaseView{}, err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return LeaseView{}, err
	}
	token := make([]byte, 24)
	if _, err = rand.Read(token); err != nil {
		listener.Close()
		return LeaseView{}, err
	}
	id := hex.EncodeToString(token)
	entry := &lease{cleanup: func() { cancel(); cleanup() }, view: LeaseView{ID: id, Name: name, ProxyURL: "http://" + listener.Addr().String()}, listener: listener, sockets: map[net.Conn]bool{}}
	// Lease ingress is only reachable through authenticated management Upgrade.
	// A random Proxy-Authorization token also protects same-host local access.
	ingressToken := id
	entry.view.ProxyURL = "http://aih:" + ingressToken + "@" + listener.Addr().String()
	resolver := managedproxy.NewResolver(dial)
	entry.server = &http.Server{Handler: managedproxy.Handler{Dial: dial, Resolve: resolver.Resolve, Token: ingressToken, OnTunnelClosed: func(c net.Conn) { m.mu.Lock(); delete(entry.sockets, c); m.mu.Unlock() }}, ReadHeaderTimeout: 10 * time.Second, MaxHeaderBytes: 16 * 1024, ConnState: func(c net.Conn, state http.ConnState) {
		m.mu.Lock()
		defer m.mu.Unlock()
		if state == http.StateClosed {
			delete(entry.sockets, c)
		} else if !entry.closing {
			entry.sockets[c] = true
		} else {
			_ = c.Close()
		}
	}}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		listener.Close()
		return LeaseView{}, fmt.Errorf("proxy manager closed")
	}
	if ctx.Err() != nil || lifetime.Err() != nil || !stopRequestCancellation() {
		m.mu.Unlock()
		listener.Close()
		return LeaseView{}, fmt.Errorf("代理任务已取消")
	}
	delete(m.pending, reservation)
	m.leases[id] = entry
	entry.timer = time.AfterFunc(LeaseTTL, func() { m.Release(id) })
	m.mu.Unlock()
	go entry.server.Serve(listener)
	retained = true
	accepted = true
	return entry.view, nil
}
func (m *LeaseManager) Connect(ctx context.Context, id string) (net.Conn, error) {
	m.mu.Lock()
	entry := m.leases[id]
	m.mu.Unlock()
	if entry == nil {
		return nil, fmt.Errorf("proxy lease expired")
	}
	return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", entry.listener.Addr().String())
}

// Renew 延长一个仍然存在的租约；过期或未知租约返回 false。
// 续租只刷新回收定时器，不改变租约 ID、入口端口或已建立的隧道。
func (m *LeaseManager) Renew(id string) bool {
	if m == nil {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return false
	}
	entry := m.leases[id]
	if entry == nil || entry.closing {
		return false
	}
	entry.timer.Stop()
	entry.timer = time.AfterFunc(LeaseTTL, func() { m.Release(id) })
	return true
}

func (m *LeaseManager) Release(id string) bool {
	m.mu.Lock()
	entry := m.leases[id]
	if entry == nil {
		m.mu.Unlock()
		return false
	}
	delete(m.leases, id)
	entry.closing = true
	entry.timer.Stop()
	sockets := make([]net.Conn, 0, len(entry.sockets))
	for c := range entry.sockets {
		sockets = append(sockets, c)
	}
	m.mu.Unlock()
	entry.server.Close()
	if entry.cleanup != nil {
		entry.cleanup()
	}
	for _, c := range sockets {
		c.Close()
	}
	return true
}
func (m *LeaseManager) Close() {
	m.mu.Lock()
	m.closed = true
	m.cancel()
	for _, cancel := range m.pending {
		cancel()
	}
	ids := make([]string, 0, len(m.leases))
	for id := range m.leases {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.Release(id)
	}
}
