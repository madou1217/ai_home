// Package sshtunnel 维持 ssh_connections.reverseTunnel 配置的反向隧道。
//
// 每条隧道独占一条 SSH 连接；断线/监听丢失后退避重建，30s 探活。隧道只把远端
// 127.0.0.1:remotePort 转发到本机 127.0.0.1:localPort（默认 22），不授予权限。
package sshtunnel

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

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

	mutex   sync.Mutex
	entries map[string]*entry
	closed  bool
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
	return &Supervisor{homeDir: homeDir, hostKeys: hostKeys, opener: opener, now: time.Now, entries: make(map[string]*entry)}
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
	supervisor.mutex.Unlock()
}

func applyHostKeys(config sshremote.Config, known map[string]string) sshremote.Config {
	if known == nil {
		return config
	}
	config.HostKeyCallback = hostKeyCallback(config.Host, config.Port, known)
	// app-state 的存量指纹按 Node/ssh2 的 ED25519 优先口径记录；固定顺序避免
	// 服务端同时提供 ECDSA 时 Go 选了另一把 key 导致“指纹变了”的假告警。
	config.HostKeyAlgorithms = []string{
		ssh.KeyAlgoED25519,
		ssh.KeyAlgoRSASHA512,
		ssh.KeyAlgoRSASHA256,
		ssh.KeyAlgoRSA,
		ssh.KeyAlgoECDSA256,
		ssh.KeyAlgoECDSA384,
		ssh.KeyAlgoECDSA521,
	}
	if config.Jump != nil {
		jump := applyHostKeys(*config.Jump, known)
		config.Jump = &jump
	}
	return config
}

func hostKeyCallback(host string, port int, known map[string]string) ssh.HostKeyCallback {
	if port == 0 {
		port = 22
	}
	id := strings.ToLower(strings.TrimSpace(host)) + ":" + strconv.Itoa(port)
	expected := strings.TrimSpace(known[id])
	return func(_ string, _ net.Addr, key ssh.PublicKey) error {
		if expected == "" {
			return nil
		}
		actual := ssh.FingerprintSHA256(key)
		if actual != expected {
			return fmt.Errorf("远端 %s 主机指纹变了（expected %s actual %s）", id, expected, actual)
		}
		return nil
	}
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
	supervisor.mutex.Unlock()

	config := applyHostKeys(spec.Config, supervisor.hostKeys)
	tunnel, err := supervisor.opener(context.Background(), config, spec.RemotePort, spec.LocalPort)
	supervisor.mutex.Lock()
	if entry.stopped || supervisor.closed || entry.generation != generation {
		supervisor.mutex.Unlock()
		if tunnel != nil {
			_ = tunnel.Close()
		}
		return
	}
	if err != nil {
		entry.status = "error"
		entry.lastError = err.Error()
		entry.attempt++
		delay := backoffDelay(entry.attempt - 1)
		entry.timer = time.AfterFunc(delay, func() { supervisor.connect(id, entry) })
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
	supervisor.mutex.Unlock()

	go supervisor.watch(id, entry, tunnel, generation)
	go supervisor.probeLoop(entry, tunnel, generation)
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
	supervisor.mutex.Unlock()
}

func (supervisor *Supervisor) probeLoop(entry *entry, tunnel Tunnel, generation int) {
	supervisor.mutex.Lock()
	ticker := entry.probeTimer
	supervisor.mutex.Unlock()
	if ticker == nil {
		return
	}
	for {
		select {
		case <-entry.probeStop:
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
		if err := tunnel.Probe(context.Background()); err != nil {
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
			status.Stats = entry.tunnel.Stats()
		}
		result = append(result, status)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ConnectionID < result[j].ConnectionID })
	return result
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

// ParseSpecs 解析 ssh_connections 原文；egress 链与端口校验失败时保留 Error 状态。
func ParseSpecs(raw []byte, homeDir string) ([]Spec, error) {
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil, nil
	}
	var records []map[string]any
	if err := json.Unmarshal(raw, &records); err != nil {
		return nil, fmt.Errorf("ssh_connections 不是合法 JSON: %w", err)
	}
	byID := make(map[string]map[string]any, len(records))
	for _, record := range records {
		if id := stringValue(record["id"]); id != "" {
			byID[id] = record
		}
	}
	specs := make([]Spec, 0)
	for _, record := range records {
		id := stringValue(record["id"])
		tunnel, _ := record["reverseTunnel"].(map[string]any)
		if id == "" || tunnel == nil {
			continue
		}
		remotePort := intValue(tunnel["remotePort"])
		localPort := intValue(tunnel["localPort"])
		if localPort == 0 {
			localPort = 22
		}
		spec := Spec{ConnectionID: id, RemotePort: remotePort, LocalPort: localPort}
		if remotePort < 1024 || remotePort > 65535 {
			spec.Error = "反向隧道远端端口必须在 1024-65535"
			specs = append(specs, spec)
			continue
		}
		if localPort < 1 || localPort > 65535 {
			spec.Error = "反向隧道本机端口必须在 1-65535"
			specs = append(specs, spec)
			continue
		}
		config, err := configFromRecord(record, byID, map[string]bool{id: true}, 0)
		if err != nil {
			spec.Error = err.Error()
			specs = append(specs, spec)
			continue
		}
		config.HomeDir = homeDir
		spec.Config = config
		specs = append(specs, spec)
	}
	return specs, nil
}

func configFromRecord(record map[string]any, byID map[string]map[string]any, seen map[string]bool, depth int) (sshremote.Config, error) {
	config := sshremote.Config{
		Host:         stringValue(record["host"]),
		Port:         intValue(record["port"]),
		User:         stringValue(record["user"]),
		AuthType:     stringValue(record["authType"]),
		Password:     rawStringValue(record["password"]),
		PrivateKey:   rawStringValue(record["privateKey"]),
		IdentityFile: stringValue(record["identityFile"]),
	}
	egress := stringValue(record["egressConnectionId"])
	if egress == "" {
		return config, nil
	}
	if depth >= 5 || seen[egress] {
		return sshremote.Config{}, fmt.Errorf("egress 链成环或超过 5 跳")
	}
	next, ok := byID[egress]
	if !ok {
		return sshremote.Config{}, fmt.Errorf("egress 连接 %s 不存在", egress)
	}
	seen[egress] = true
	jump, err := configFromRecord(next, byID, seen, depth+1)
	if err != nil {
		return sshremote.Config{}, err
	}
	config.Jump = &jump
	return config, nil
}

func stringValue(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func rawStringValue(value any) string {
	text, _ := value.(string)
	return text
}

func intValue(value any) int {
	switch number := value.(type) {
	case float64:
		return int(number)
	case int:
		return number
	case string:
		parsed, _ := strconv.Atoi(strings.TrimSpace(number))
		return parsed
	default:
		return 0
	}
}
