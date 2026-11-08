// Package relayudp 是「跟随 AIH 端口」模式下 SOCKS5 UDP ASSOCIATE 的前端。
//
// 为什么需要它：UDP 必须占一个独立的 UDP 端口，而边车每次关联给客户端的 BND 都是临时端口
// （实测 127.0.0.1:54038 / 192.168.31.8:59244 这种），防火墙/安全组/frp 无法预先放行，
// AWS 那种 1:1 NAT 还会回私网地址。所以由前端占一个固定已知的 UDP 端口（就用 AIH 那个
// 端口号的 UDP 侧），自己和客户端打交道，再把数据报桥接给回环上的边车中继。
//
// 数据报是原样透传的：客户端按 SOCKS5 UDP 封装（RSV+FRAG+目标地址+目标端口+正文）发来，
// 边车中继也认同一套格式，所以这里不做任何解码，只做「谁的数据报 → 哪个关联」的路由。
//
// 关联路由与 Node 侧 lib/server/relay-udp-front.js 同构：
//   - 来自边车 BND 的数据报是回程，交给锁定了该关联的客户端；
//   - 其余是客户端来报，按客户端 IP:端口 查表；没锁过且只有一个未锁定关联时锁定它，
//     歧义（同一来源对不上、或同时有多个未锁定关联）时丢弃，避免把 A 节点的流量塞进 B 节点。
package relayudp

import (
	"errors"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// DefaultIdleTimeout 是关联没有任何数据报往来后保留的时长（与 Node 一致）。
	DefaultIdleTimeout = 120 * time.Second
	// DefaultReapInterval 是空闲关联的扫描间隔（与 Node 一致）。
	DefaultReapInterval = 30 * time.Second
	// maxDatagramBytes 覆盖 UDP 数据报的理论上限，避免截断。
	maxDatagramBytes = 64 * 1024
)

// BND 是一个 UDP 绑定地址：既用于边车在 ASSOCIATE 回复里给的 BND，
// 也用于前端播报给客户端的地址。
type BND struct {
	Host string
	Port int
}

// String 返回 host:port（IPv6 字面量会带方括号）。
func (bnd BND) String() string {
	return net.JoinHostPort(bnd.Host, strconv.Itoa(bnd.Port))
}

// Config 是前端参数，零值可用。
type Config struct {
	// Host 是监听的 UDP 地址，默认 0.0.0.0（与 Node 的 udp4 一致）。
	Host string
	// Port 是监听的 UDP 端口，0 表示由系统分配（测试用；线上按 AIH 监听端口填）。
	Port int
	// AdvertiseHost 是播报给客户端的主机：默认用客户端连过来的本机地址，
	// 1:1 NAT（AWS 弹性 IP）或域名入口时在这里钉住外部地址。
	AdvertiseHost string
	// AdvertisePort 是播报给客户端的端口：默认用实际绑定的端口，
	// 经 frp 之类的端口转发（本地 9527 → 远端 29527）时在这里钉住。
	AdvertisePort int
	// IdleTimeout 是空闲回收阈值，0 表示 DefaultIdleTimeout。
	IdleTimeout time.Duration
	// Now 是时钟，测试注入；nil 表示 time.Now。
	Now func() time.Time
	// Logf 是告警出口（丢弃、发送失败），nil 表示静默。
	Logf func(format string, args ...any)
}

// Front 用单个共享 UDP socket 桥接客户端与多条边车关联。
type Front struct {
	cfg Config

	mu        sync.Mutex
	conn      *net.UDPConn
	bound     *net.UDPAddr
	byID      map[string]*association
	bySidecar map[string]string
	byClient  map[string]string
	done      chan struct{}

	wg sync.WaitGroup
}

// association 是一条 UDP 关联：控制连接创建它，首报锁定客户端，空闲或控制连接断开时回收。
type association struct {
	id        string
	sidecarTo *net.UDPAddr
	clientKey string
	client    *net.UDPAddr
	lastUsed  time.Time
}

// New 建前端；此时还不绑定端口，Start 才绑定。
func New(cfg Config) *Front {
	cfg.Host = strings.TrimSpace(cfg.Host)
	if cfg.Host == "" {
		cfg.Host = "0.0.0.0"
	}
	if cfg.IdleTimeout <= 0 {
		cfg.IdleTimeout = DefaultIdleTimeout
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	return &Front{
		cfg:       cfg,
		byID:      make(map[string]*association),
		bySidecar: make(map[string]string),
		byClient:  make(map[string]string),
	}
}

// Start 绑定 UDP 端口并起读循环与空闲回收循环；重复调用是幂等的。
func (front *Front) Start() error {
	front.mu.Lock()
	if front.conn != nil {
		front.mu.Unlock()
		return nil
	}
	front.mu.Unlock()

	addr, err := net.ResolveUDPAddr("udp4", net.JoinHostPort(front.cfg.Host, strconv.Itoa(front.cfg.Port)))
	if err != nil {
		return err
	}
	conn, err := net.ListenUDP("udp4", addr)
	if err != nil {
		return err
	}

	front.mu.Lock()
	if front.conn != nil {
		// 并发 Start：另一个调用已经绑定成功，保留先到的那个。
		front.mu.Unlock()
		_ = conn.Close()
		return nil
	}
	front.conn = conn
	front.bound = conn.LocalAddr().(*net.UDPAddr)
	done := make(chan struct{})
	front.done = done
	front.mu.Unlock()

	front.wg.Add(2)
	go front.readLoop(conn)
	go front.reapLoop(done)
	return nil
}

// Close 停掉循环、关闭共享 socket 并清空关联表；可重复调用。
func (front *Front) Close() error {
	front.mu.Lock()
	conn := front.conn
	done := front.done
	front.conn = nil
	front.bound = nil
	front.done = nil
	front.byID = make(map[string]*association)
	front.bySidecar = make(map[string]string)
	front.byClient = make(map[string]string)
	front.mu.Unlock()

	if done != nil {
		close(done)
	}
	if conn == nil {
		return nil
	}
	// 先关 socket 再等循环退出：读循环阻塞在 ReadFromUDP 上，只有关闭才能唤醒。
	err := conn.Close()
	front.wg.Wait()
	return err
}

// Enabled 表示 UDP 前端是否已绑定端口。未启用时调用方应回 SOCKS5「命令不支持」，
// 不要让客户端去试一条根本到不了的 UDP 通路。
func (front *Front) Enabled() bool {
	front.mu.Lock()
	defer front.mu.Unlock()
	return front.conn != nil
}

// BoundPort 返回实际绑定的端口；还没启动时返回配置里的端口。
func (front *Front) BoundPort() int {
	front.mu.Lock()
	defer front.mu.Unlock()
	if front.bound == nil {
		return front.cfg.Port
	}
	return front.bound.Port
}

// Advertise 返回要回复给客户端的 BND —— 客户端把 UDP 数据报发到这里。
//
// 这正是「BND 改写」：边车给的临时端口不能给客户端，必须换成前端这个固定端口。
// host 优先用 advertiseHost，否则用 fallbackHost（客户端连到本机时的地址，通常取自
// 控制连接的 LocalAddr —— UDP 共享 socket 上看不到逐客户端的本地地址）；
// port 优先用 advertisePort，否则用实际绑定端口。
func (front *Front) Advertise(fallbackHost string) BND {
	front.mu.Lock()
	port := front.cfg.Port
	if front.bound != nil {
		port = front.bound.Port
	}
	front.mu.Unlock()

	if front.cfg.AdvertisePort > 0 {
		port = front.cfg.AdvertisePort
	}
	host := strings.TrimSpace(front.cfg.AdvertiseHost)
	if host == "" {
		host = strings.TrimSpace(fallbackHost)
	}
	return BND{Host: host, Port: port}
}

// AddAssociation 登记一条关联：id 由控制连接持有，sidecarBND 是边车回复的绑定地址。
// 同一个 id 重复登记会替换旧关联；未启动时拒绝登记（与 Node 一致，避免应答一条不存在的通路）。
func (front *Front) AddAssociation(id string, sidecarBND BND) bool {
	id = strings.TrimSpace(id)
	host := strings.TrimSpace(sidecarBND.Host)
	if id == "" || host == "" || sidecarBND.Port <= 0 || sidecarBND.Port > 65535 {
		return false
	}
	bnd := BND{Host: host, Port: sidecarBND.Port}
	to, err := net.ResolveUDPAddr("udp4", bnd.String())
	if err != nil {
		front.cfg.Logf("[aih:relay-udp] 关联 %s 的边车地址 %s 无法解析: %v", id, bnd, err)
		return false
	}

	front.mu.Lock()
	defer front.mu.Unlock()
	if front.conn == nil {
		return false
	}
	if old := front.byID[id]; old != nil {
		front.removeLocked(old)
	}
	front.byID[id] = &association{
		id:        id,
		sidecarTo: to,
		lastUsed:  front.cfg.Now(),
	}
	front.bySidecar[addrKey(to)] = id
	return true
}

// RemoveAssociation 回收一条关联（控制连接断开时调用）。
func (front *Front) RemoveAssociation(id string) {
	front.mu.Lock()
	defer front.mu.Unlock()
	if assoc := front.byID[id]; assoc != nil {
		front.removeLocked(assoc)
	}
}

// AssociationCount 返回活动关联数（诊断用）。
func (front *Front) AssociationCount() int {
	front.mu.Lock()
	defer front.mu.Unlock()
	return len(front.byID)
}

// ReapIdle 回收空闲超过 IdleTimeout 的关联，返回回收数量。
func (front *Front) ReapIdle() int {
	deadline := front.cfg.Now().Add(-front.cfg.IdleTimeout)

	front.mu.Lock()
	defer front.mu.Unlock()
	var stale []*association
	for _, assoc := range front.byID {
		if assoc.lastUsed.After(deadline) {
			continue
		}
		stale = append(stale, assoc)
	}
	for _, assoc := range stale {
		front.removeLocked(assoc)
	}
	return len(stale)
}

// readLoop 是唯一的收包点：所有客户端的 UDP 数据报都从这一个共享 socket 进来。
func (front *Front) readLoop(conn *net.UDPConn) {
	defer front.wg.Done()
	buf := make([]byte, maxDatagramBytes)
	for {
		n, from, err := conn.ReadFromUDP(buf)
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			front.cfg.Logf("[aih:relay-udp] socket error: %v", err)
			continue
		}
		front.handleDatagram(buf[:n], from, func(payload []byte, to *net.UDPAddr) {
			if _, writeErr := conn.WriteToUDP(payload, to); writeErr != nil {
				front.cfg.Logf("[aih:relay-udp] 发送数据报失败: %v", writeErr)
			}
		})
	}
}

// reapLoop 定期回收空闲关联；注入时钟的测试直接调 ReapIdle。
func (front *Front) reapLoop(done <-chan struct{}) {
	defer front.wg.Done()
	ticker := time.NewTicker(DefaultReapInterval)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			front.ReapIdle()
		}
	}
}

// handleDatagram 是路由核心：send 由调用方给（生产是共享 socket，测试注入假发送）。
func (front *Front) handleDatagram(payload []byte, from *net.UDPAddr, send func([]byte, *net.UDPAddr)) {
	if from == nil || send == nil {
		return
	}
	key := addrKey(from)

	front.mu.Lock()
	if id, ok := front.bySidecar[key]; ok {
		assoc := front.byID[id]
		if assoc == nil || assoc.client == nil {
			// 客户端还没发过数据报（关联尚未锁定）：这条回程没有归属，丢掉。
			front.mu.Unlock()
			return
		}
		to := assoc.client
		assoc.lastUsed = front.cfg.Now()
		front.mu.Unlock()
		send(payload, to)
		return
	}

	assoc := front.pickAssociationLocked(key)
	if assoc == nil {
		front.mu.Unlock()
		front.cfg.Logf("[aih:relay-udp] 丢弃来自 %s 的数据报：没有可归属的中转关联", key)
		return
	}
	if assoc.client == nil {
		assoc.clientKey = key
		assoc.client = from
		front.byClient[key] = assoc.id
	}
	to := assoc.sidecarTo
	assoc.lastUsed = front.cfg.Now()
	front.mu.Unlock()
	send(payload, to)
}

// pickAssociationLocked 按 Node 的规则选关联：已经锁定给该来源的直接用；
// 否则只有「恰好一个未锁定关联」时才敢认领，多个未锁定就是歧义。
func (front *Front) pickAssociationLocked(key string) *association {
	if id, ok := front.byClient[key]; ok {
		return front.byID[id]
	}
	var only *association
	for _, assoc := range front.byID {
		if assoc.client != nil {
			continue
		}
		if only != nil {
			return nil
		}
		only = assoc
	}
	return only
}

// removeLocked 回收一条关联及其两张表里的索引（调用方持有锁）。
func (front *Front) removeLocked(assoc *association) {
	delete(front.byID, assoc.id)
	// 同一个 BND 可能已被后来的关联重新占用：只删仍然指向自己的表项。
	// 无条件 delete 会把新关联的回程路由一起删掉（Node 侧就是这样，Go 版按归属删）。
	if key := addrKey(assoc.sidecarTo); front.bySidecar[key] == assoc.id {
		delete(front.bySidecar, key)
	}
	if assoc.clientKey != "" && front.byClient[assoc.clientKey] == assoc.id {
		delete(front.byClient, assoc.clientKey)
	}
}

// addrKey 是对端地址的稳定键；IPv4 字面量与 Node 的 rinfo.address 同形（点分十进制）。
func addrKey(addr *net.UDPAddr) string {
	if addr == nil {
		return ""
	}
	return net.JoinHostPort(addr.IP.String(), strconv.Itoa(addr.Port))
}
