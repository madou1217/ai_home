// Package sshtunnel 维持 ssh_connections.reverseTunnel 配置的反向隧道。
//
// 每条隧道独占一条 SSH 连接；断线/监听丢失后退避重建，30s 探活。隧道只把远端
// 127.0.0.1:remotePort 转发到本机 127.0.0.1:localPort（默认 22），不授予权限。
package sshtunnel

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/sshremote"
)

var backoff = []time.Duration{2 * time.Second, 5 * time.Second, 10 * time.Second, 30 * time.Second, 60 * time.Second}

const probeInterval = 30 * time.Second

// Spec 是一条连接的反向隧道事实。
type Spec struct {
	ConnectionID string
	Config       sshremote.Config
	RemotePort   int
	LocalPort    int
	// Error 非空时表示配置本身无效（egress 缺失/成环、端口非法）；只进状态，不建隧道。
	Error string
}

// Status 是管理面/日志可见的隧道状态；不含凭据。
type Status struct {
	ConnectionID string                       `json:"connectionId"`
	State        string                       `json:"state"`
	RemotePort   int                          `json:"remotePort"`
	LocalPort    int                          `json:"localPort"`
	Attempt      int                          `json:"attempt"`
	Error        string                       `json:"error,omitempty"`
	OpenedAt     int64                        `json:"openedAt,omitempty"`
	LastProbeAt  int64                        `json:"lastProbeAt,omitempty"`
	Stats        sshremote.ReverseTunnelStats `json:"stats"`
}

// Tunnel 是 Supervisor 需要的最小隧道能力；测试可注入 fake。
type Tunnel interface {
	Probe(context.Context) error
	Done() <-chan struct{}
	Close() error
	Stats() sshremote.ReverseTunnelStats
}

// Opener 建立一条反向隧道；默认是 sshremote.OpenReverseTunnel。
type Opener func(context.Context, sshremote.Config, int, int) (Tunnel, error)

// Supervisor 按 connectionId 维护隧道集合。
type Supervisor struct {
	homeDir  string
	hostKeys map[string]string
	opener   Opener
	now      func() time.Time

	mutex    sync.Mutex
	entries  map[string]*entry
	watchers map[chan struct{}]struct{}
	closed   bool
}

type entry struct {
	spec       Spec
	tunnel     Tunnel
	status     string
	lastError  string
	attempt    int
	generation int
	openedAt   time.Time
	lastProbe  time.Time
	timer      *time.Timer
	probeTimer *time.Ticker
	probeStop  chan struct{}
	cancel     context.CancelFunc
	stopped    bool
}

// New 创建监督者；homeDir 用于 known_hosts/identity 默认路径。
func New(homeDir string) *Supervisor {
	return NewWithOpener(homeDir, func(ctx context.Context, config sshremote.Config, remotePort, localPort int) (Tunnel, error) {
		return sshremote.OpenReverseTunnel(ctx, config, remotePort, localPort)
	})
}

// NewWithOpener 允许测试注入隧道实现。
func NewWithOpener(homeDir string, opener Opener) *Supervisor {
	return NewWithHostKeys(homeDir, nil, opener)
}

// NewWithHostKeys 注入 app-state ssh_known_hosts 的指纹（host:port → SHA256）；
// 未知主机仍按 TOFU 放行，指纹不一致拒绝。
func NewWithHostKeys(homeDir string, hostKeys map[string]string, opener Opener) *Supervisor {
	return &Supervisor{homeDir: homeDir, hostKeys: hostKeys, opener: opener, now: time.Now, entries: make(map[string]*entry), watchers: make(map[chan struct{}]struct{})}
}

// Reconcile 从 ssh_connections 原文解析并应用；不阻塞等待连接建立。
func (supervisor *Supervisor) Reconcile(raw []byte) error {
	specs, err := ParseSpecs(raw, supervisor.homeDir)
	if err != nil {
		return err
	}
	supervisor.ReconcileSpecs(specs)
	return nil
}

// ReconcileSpecs 让运行中的隧道与给定集合一致。
func (supervisor *Supervisor) ReconcileSpecs(specs []Spec) {
	if supervisor == nil {
		return
	}
	supervisor.mutex.Lock()
	if supervisor.closed {
		supervisor.mutex.Unlock()
		return
	}
	wanted := make(map[string]Spec, len(specs))
	for _, spec := range specs {
		if strings.TrimSpace(spec.ConnectionID) == "" {
			continue
		}
		wanted[spec.ConnectionID] = spec
	}
	for id, current := range supervisor.entries {
		next, ok := wanted[id]
		if !ok || !sameSpec(current.spec, next) {
			supervisor.stopLocked(current)
			delete(supervisor.entries, id)
		}
	}
	for id, spec := range wanted {
		if _, exists := supervisor.entries[id]; exists {
			continue
		}
		entry := &entry{spec: spec, status: "connecting"}
		if spec.Error != "" {
			entry.status = "error"
			entry.lastError = spec.Error
		}
		supervisor.entries[id] = entry
		if spec.Error == "" {
			go supervisor.connect(id, entry)
		}
	}
	supervisor.notifyLocked()
	supervisor.mutex.Unlock()
}

func sameSpec(left Spec, right Spec) bool {
	return left.RemotePort == right.RemotePort &&
		left.LocalPort == right.LocalPort &&
		left.Error == right.Error &&
		sameConfig(left.Config, right.Config)
}

func sameConfig(left sshremote.Config, right sshremote.Config) bool {
	if left.Host != right.Host || left.Port != right.Port || left.User != right.User ||
		left.AuthType != right.AuthType || left.Password != right.Password ||
		left.PrivateKey != right.PrivateKey || left.IdentityFile != right.IdentityFile ||
		left.KnownHostsPath != right.KnownHostsPath || left.HomeDir != right.HomeDir {
		return false
	}
	if (left.Jump == nil) != (right.Jump == nil) {
		return false
	}
	if left.Jump != nil {
		return sameConfig(*left.Jump, *right.Jump)
	}
	return true
}

func (supervisor *Supervisor) connect(id string, entry *entry) {
	supervisor.mutex.Lock()
	if entry.stopped || supervisor.closed {
		supervisor.mutex.Unlock()
		return
	}
	entry.generation++
	generation := entry.generation
	spec := entry.spec
	ctx, cancel := context.WithCancel(context.Background())
	entry.cancel = cancel
	supervisor.mutex.Unlock()

	config := ApplyHostKeys(spec.Config, supervisor.hostKeys)
	tunnel, err := supervisor.opener(ctx, config, spec.RemotePort, spec.LocalPort)
	supervisor.mutex.Lock()
	if entry.stopped || supervisor.closed || entry.generation != generation {
		supervisor.mutex.Unlock()
		cancel()
		if tunnel != nil {
			_ = tunnel.Close()
		}
		return
	}
	if err != nil {
		cancel()
		entry.cancel = nil
		if tunnel != nil {
			_ = tunnel.Close()
		}
		entry.status = "error"
		entry.lastError = err.Error()
		entry.attempt++
		delay := backoffDelay(entry.attempt - 1)
		entry.timer = time.AfterFunc(delay, func() { supervisor.connect(id, entry) })
		supervisor.notifyLocked()
		supervisor.mutex.Unlock()
		return
	}
	entry.tunnel = tunnel
	entry.status = "open"
	entry.lastError = ""
	entry.attempt = 0
	entry.openedAt = supervisor.now()
	entry.probeTimer = time.NewTicker(probeInterval)
	entry.probeStop = make(chan struct{})
	ticker, stopCh := entry.probeTimer, entry.probeStop
	supervisor.notifyLocked()
	supervisor.mutex.Unlock()

	go supervisor.watch(id, entry, tunnel, generation)
	go supervisor.probeLoop(ctx, entry, tunnel, generation, ticker, stopCh)
}

func (supervisor *Supervisor) watch(id string, entry *entry, tunnel Tunnel, generation int) {
	<-tunnel.Done()
	supervisor.mutex.Lock()
	if entry.stopped || supervisor.closed || entry.generation != generation {
		supervisor.mutex.Unlock()
		return
	}
	supervisor.stopTunnelLocked(entry)
	entry.status = "error"
	entry.lastError = "connection_closed"
	entry.attempt++
	delay := backoffDelay(entry.attempt - 1)
	entry.timer = time.AfterFunc(delay, func() { supervisor.connect(id, entry) })
	supervisor.notifyLocked()
	supervisor.mutex.Unlock()
}

func (supervisor *Supervisor) probeLoop(ctx context.Context, entry *entry, tunnel Tunnel, generation int, ticker *time.Ticker, stopCh <-chan struct{}) {
	for {
		select {
		case <-stopCh:
			return
		case <-ticker.C:
		}
		supervisor.mutex.Lock()
		if entry.stopped || supervisor.closed || entry.generation != generation {
			supervisor.mutex.Unlock()
			return
		}
		entry.lastProbe = supervisor.now()
		supervisor.mutex.Unlock()
		if err := tunnel.Probe(ctx); err != nil {
			_ = tunnel.Close()
			return
		}
	}
}

func backoffDelay(attempt int) time.Duration {
	if attempt < 0 {
		attempt = 0
	}
	if attempt >= len(backoff) {
		return backoff[len(backoff)-1]
	}
	return backoff[attempt]
}

// Status 返回按 connectionId 排序的快照。
func (supervisor *Supervisor) Status() []Status {
	if supervisor == nil {
		return nil
	}
	supervisor.mutex.Lock()
	defer supervisor.mutex.Unlock()
	result := make([]Status, 0, len(supervisor.entries))
	for id, entry := range supervisor.entries {
		status := Status{
			ConnectionID: id,
			State:        entry.status,
			RemotePort:   entry.spec.RemotePort,
			LocalPort:    entry.spec.LocalPort,
			Attempt:      entry.attempt,
			Error:        entry.lastError,
		}
		if !entry.openedAt.IsZero() {
			status.OpenedAt = entry.openedAt.UnixMilli()
		}
		if !entry.lastProbe.IsZero() {
			status.LastProbeAt = entry.lastProbe.UnixMilli()
		}
		if entry.tunnel != nil {
			if bound, ok := entry.tunnel.(interface{ BoundRemotePort() int }); ok {
				status.RemotePort = bound.BoundRemotePort()
			}
			status.Stats = entry.tunnel.Stats()
		}
		result = append(result, status)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ConnectionID < result[j].ConnectionID })
	return result
}

// Reconnect 关闭指定连接的隧道并按当前 spec 立即重连；不存在时返回 false。
func (supervisor *Supervisor) Reconnect(connectionID string) bool {
	if supervisor == nil {
		return false
	}
	supervisor.mutex.Lock()
	if supervisor.closed {
		supervisor.mutex.Unlock()
		return false
	}
	current, ok := supervisor.entries[connectionID]
	if !ok {
		supervisor.mutex.Unlock()
		return false
	}
	spec := current.spec
	supervisor.stopLocked(current)
	next := &entry{spec: spec, status: "connecting"}
	if spec.Error != "" {
		next.status = "error"
		next.lastError = spec.Error
	}
	supervisor.entries[connectionID] = next
	supervisor.notifyLocked()
	if spec.Error == "" {
		go supervisor.connect(connectionID, next)
	}
	supervisor.mutex.Unlock()
	return true
}

// Subscribe 返回状态变化通知（仅信号，读取用 Status）。
func (supervisor *Supervisor) Subscribe() (<-chan struct{}, func()) {
	channel := make(chan struct{}, 1)
	if supervisor == nil {
		return channel, func() {}
	}
	supervisor.mutex.Lock()
	if supervisor.closed {
		supervisor.mutex.Unlock()
		return channel, func() {}
	}
	supervisor.watchers[channel] = struct{}{}
	supervisor.mutex.Unlock()
	return channel, func() {
		supervisor.mutex.Lock()
		delete(supervisor.watchers, channel)
		supervisor.mutex.Unlock()
	}
}

func (supervisor *Supervisor) notifyLocked() {
	for channel := range supervisor.watchers {
		select {
		case channel <- struct{}{}:
		default:
		}
	}
}

// Close 停止所有隧道与重连计时器。
func (supervisor *Supervisor) Close() {
	if supervisor == nil {
		return
	}
	supervisor.mutex.Lock()
	if supervisor.closed {
		supervisor.mutex.Unlock()
		return
	}
	supervisor.closed = true
	for _, entry := range supervisor.entries {
		supervisor.stopLocked(entry)
	}
	supervisor.entries = nil
	supervisor.mutex.Unlock()
}

func (supervisor *Supervisor) stopLocked(entry *entry) {
	entry.stopped = true
	entry.generation++
	if entry.timer != nil {
		entry.timer.Stop()
		entry.timer = nil
	}
	supervisor.stopTunnelLocked(entry)
}

func (supervisor *Supervisor) stopTunnelLocked(entry *entry) {
	if entry.cancel != nil {
		entry.cancel()
		entry.cancel = nil
	}
	if entry.probeStop != nil {
		close(entry.probeStop)
		entry.probeStop = nil
	}
	if entry.probeTimer != nil {
		entry.probeTimer.Stop()
		entry.probeTimer = nil
	}
	if entry.tunnel != nil {
		_ = entry.tunnel.Close()
		entry.tunnel = nil
	}
}
