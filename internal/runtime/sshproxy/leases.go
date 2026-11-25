package sshproxy

import (
	"context"
	"crypto/rand"
	"errors"
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
	"github.com/madou1217/ai_home/internal/runtime/updateproxy"
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
	// AnonymousProxyURL 是不要求 Proxy-Authorization 的 loopback 入口。
	//
	// 一部分客户端（winget 的 --proxy 已实测）会把代理 URL 里的 userinfo 丢掉，
	// 又不支持显式凭据，对认证入口一律 407。给它们一个裸 host:port 才能走代理。
	// 只监听 127.0.0.1，作用域与系统代理入口相同。
	AnonymousProxyURL string `json:"-"`
}
type lease struct {
	view     LeaseView
	listener net.Listener
	server   *http.Server
	// 匿名入口与认证入口共享同一个 dial，只是不做 Token 校验。
	anonListener net.Listener
	anonServer   *http.Server
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
	identities := make(map[string]string, len(nodes))
	for _, node := range nodes {
		if node.Raw["managedBy"] == "sshproxy" {
			continue
		}
		available := node.Protocol == "http" || node.Protocol == "https" || node.Protocol == "socks5" || node.Protocol == "socks5h" || proxypoollease.Available(m.engineProvider())
		item := Candidate{ID: node.ID, Name: node.Name, Source: "pool", Available: available}
		if !available {
			item.Error = "此协议需要已安装的代理内核"
		}
		identities[node.ID] = egress.BuildExitIdentity(node.Protocol, node.Server, node.Port)
		result = append(result, item)
	}
	if m.pool != nil && m.pool.IsPoolReady() {
		result = append(result, Candidate{ID: "pool", Name: "当前代理池", Source: "pool", Available: true})
	}
	m.sortByPreference(result, identities)
	return result
}

// sortByPreference 按节点健康账本的偏好分排序候选：可用优先、分高优先。
//
// 此前这里只按 Source + ID 字典序，于是「哪个出口更值得先用」在这里和
// NodeHealthLedger.PickBest 是两套结论——自动代理会永远先试同一个出口，
// 即使账本里有更新鲜的失败/成功探测。现在两边共用 PreferenceScore。
//
// 按 identity 而不是名字查分：候选名来自订阅快照，账本条目名来自池配置，
// 实测两者不同名；只有出口身份（protocol|server|port）是共同键。
// 同分时保留原来的 Source(ssh 优先)/ID 顺序，保证输出稳定。
func (m *LeaseManager) sortByPreference(result []Candidate, identities map[string]string) {
	if m.pool == nil {
		// 没有池管理器就没有健康账本；保持原有的确定性顺序。
		sort.SliceStable(result, func(i, j int) bool { return candidateLess(result[i], result[j]) })
		return
	}
	at := time.Now().UnixMilli()
	score := func(item Candidate) int {
		if !item.Available {
			return -1 // 不可用恒排在可用之后
		}
		identity := identities[item.ID]
		if identity == "" {
			// 没有出口身份的候选（SSH 出口）在账本里没有事实，按「从未探测」
			// 计分，而不是 0：0 是「新鲜失败」的分档，会把从未失败的出口
			// 当成刚失败过，直接沉到末尾。
			return egress.ScoreNeverProbed
		}
		return m.pool.NodePreferenceScoreByIdentity(identity, at)
	}
	sort.SliceStable(result, func(i, j int) bool {
		left, right := score(result[i]), score(result[j])
		if left != right {
			return left > right
		}
		return candidateLess(result[i], result[j])
	})
}

func candidateLess(left, right Candidate) bool {
	if left.Source != right.Source {
		return left.Source == "ssh"
	}
	return left.ID < right.ID
}

// Rotation 用当前候选顺序装配自动出口轮换器（进程内，不经管理面 HTTP）。
//
// WebUI 安装作业与 CLI 自动代理共用同一份 updateproxy 状态机，只是取租约的
// 入口不同：这里直接用本进程的 LeaseManager，因此不需要管理密钥。
func (m *LeaseManager) Rotation(notify func(string)) *updateproxy.EgressRotation {
	if m == nil {
		return nil
	}
	return updateproxy.NewEgressRotation(
		func(context.Context) ([]string, error) {
			// 只轮换有可用入口的候选；服务端排序（含健康账本）即优先级。
			ids := make([]string, 0, 8)
			for _, candidate := range m.Candidates() {
				if candidate.Available && candidate.ID != "" {
					ids = append(ids, candidate.ID)
				}
			}
			if len(ids) == 0 {
				return nil, errors.New("没有可用的受管代理出口")
			}
			return ids, nil
		},
		func(ctx context.Context, selector string) (updateproxy.EgressLease, error) {
			view, err := m.Acquire(ctx, selector)
			if err != nil {
				return updateproxy.EgressLease{}, err
			}
			id := view.ID
			return updateproxy.EgressLease{
				URL:          view.ProxyURL,
				AnonymousURL: view.AnonymousProxyURL,
				Name:         view.Name,
				Identity:     m.identityOf(selector),
				Release: func() {
					m.Release(id)
				},
			}, nil
		},
		notify,
	)
}

// identityOf 把候选 ID 换成健康账本使用的出口身份。
func (m *LeaseManager) identityOf(selector string) string {
	if m == nil {
		return ""
	}
	for _, candidate := range m.Candidates() {
		if candidate.ID == selector {
			return candidate.Identity
		}
	}
	return ""
}

// RecordOutcome 把任务级出口结果写回健康账本。
//
// 优先按出口身份记账：账本条目名由绑定方式决定（池内节点是 node-<index>、
// SSH 是 ssh|connId），拿显示名查会全部落空、结果被静默丢弃。identity 为空时
// 退回按名字查，兼容只给名字的调用方。
func (m *LeaseManager) RecordOutcome(name string, identity string, ok bool, reason string) {
	if m == nil || m.pool == nil {
		return
	}
	if strings.TrimSpace(identity) != "" {
		m.pool.RecordEgressOutcomeByIdentity(identity, ok, reason)
		return
	}
	m.recordOutcome(name, ok, reason)
}

// recordOutcome 把任务级出口结果写回健康账本（没有池管理器时安全跳过）。
func (m *LeaseManager) recordOutcome(name string, ok bool, reason string) {
	if m == nil || m.pool == nil || strings.TrimSpace(name) == "" {
		return
	}
	m.pool.RecordEgressOutcome(name, ok, reason)
}
func (m *LeaseManager) dialer(ctx context.Context, selector string) (managedproxy.Dialer, string, func(), error) {
	// auto 的含义是「给我一个能用的出口」，不是「只试排第一的那个」。
	// 排在首位的候选可能只是「可用」标记为真、实际内核/SSH 通道启动失败
	// （实测 AWS 出口未就绪时 auto 直接 409，而池里有 100+ 个可用出口）。
	// 因此按同一份候选顺序逐个尝试，首个真正建立成功的才返回。
	if selector == "" || selector == "auto" {
		var lastErr error
		for _, candidate := range m.Candidates() {
			if !candidate.Available || candidate.ID == "" {
				continue
			}
			dial, name, cleanup, retryErr := m.dialer(ctx, candidate.ID)
			if retryErr == nil {
				return dial, name, cleanup, nil
			}
			lastErr = retryErr
		}
		if lastErr != nil {
			return nil, "", func() {}, fmt.Errorf("没有成功建立的可用出口（最后一次失败：%w）", lastErr)
		}
		return nil, "", func() {}, fmt.Errorf("代理池中没有可用出口；请在 SSH 主机中启用作为代理并等待连接")
	}
	candidates := m.Candidates()
	var item *Candidate
	for i := range candidates {
		if candidates[i].ID == selector {
			item = &candidates[i]
			break
		}
	}
	if item == nil || !item.Available {
		return nil, "", func() {}, fmt.Errorf("指定代理不存在或未就绪")
	}
	if strings.HasPrefix(selector, "ssh:") {
		id := strings.TrimPrefix(selector, "ssh:")
		return func(ctx context.Context, _, address string) (net.Conn, error) { return m.ssh.Dial(ctx, id, address) }, item.Name, func() {}, nil
	}
	var proxy *url.URL
	if selector == "pool" {
		state, _ := egress.ReadLivePoolState(m.home, nil)
		if state == nil {
			return nil, "", func() {}, fmt.Errorf("代理池未就绪")
		}
		proxy, _ = url.Parse(state.ProxyURL)
	} else {
		nodes, _ := egress.ReadProxyPoolNodes(m.home)
		for _, node := range nodes {
			if node.ID == selector {
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
	trackSockets := func(c net.Conn, state http.ConnState) {
		m.mu.Lock()
		defer m.mu.Unlock()
		if state == http.StateClosed {
			delete(entry.sockets, c)
		} else if !entry.closing {
			entry.sockets[c] = true
		} else {
			_ = c.Close()
		}
	}
	entry.server = &http.Server{Handler: managedproxy.Handler{Dial: dial, Resolve: resolver.Resolve, Token: ingressToken, OnTunnelClosed: func(c net.Conn) { m.mu.Lock(); delete(entry.sockets, c); m.mu.Unlock() }}, ReadHeaderTimeout: 10 * time.Second, MaxHeaderBytes: 16 * 1024, ConnState: trackSockets}

	// 匿名入口：与认证入口共享 dial，但 Token 留空（不校验 Proxy-Authorization）。
	// 供那些无法携带代理凭据的客户端使用（winget --proxy 已实测）。
	anonListener, anonErr := net.Listen("tcp", "127.0.0.1:0")
	if anonErr == nil {
		entry.anonListener = anonListener
		entry.anonServer = &http.Server{Handler: managedproxy.Handler{Dial: dial, Resolve: resolver.Resolve, OnTunnelClosed: func(c net.Conn) { m.mu.Lock(); delete(entry.sockets, c); m.mu.Unlock() }}, ReadHeaderTimeout: 10 * time.Second, MaxHeaderBytes: 16 * 1024, ConnState: trackSockets}
		entry.view.AnonymousProxyURL = "http://" + anonListener.Addr().String()
	}
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
	if entry.anonServer != nil && entry.anonListener != nil {
		go entry.anonServer.Serve(entry.anonListener)
	}
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
	if entry.anonServer != nil {
		_ = entry.anonServer.Close()
	}
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
