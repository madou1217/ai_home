package codexenvironments

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
	"sync"
	"time"
)

// HostSupervisor 维持若干条 url 模式通道宿主。
//
// url 模式要求 AIH 常驻：Codex 只连一个本机 ws 地址，监听和 SSH 链路由这里负责。
// 因此宿主的生命周期必须独立于 CLI 进程，并具备断线重建能力——与
// runtime/sshtunnel 的思路一致：失败退避、周期探活、配置变化时整体重建。
//
// 端口分配刻意用固定端口而不是每次随机：Codex 侧写进 environments.toml 的
// 地址必须稳定，否则每次重启都要重写配置文件。
type HostSupervisor struct {
	opener HostOpener
	now    func() time.Time

	mu     sync.Mutex
	hosts  map[string]*HostStatus
	closed bool
	wg     sync.WaitGroup
}

// HostOpener 打开一条宿主；生产实现是 OpenHost，测试可注入。
type HostOpener func(ctx context.Context, options HostOptions) (*Host, error)

// HostSpec 描述一条应当常驻的 url 模式宿主。
type HostSpec struct {
	Connection    Connection
	RemoteAddress string
	ListenPort    int
	BearerToken   string
	Cwd           string
	// CodexPath 是远端 codex 的可执行文件绝对路径（探测结果）。
	CodexPath string
}

// HostStatus 是可对外展示的宿主状态；不含凭据。
type HostStatus struct {
	ConnectionID string
	State        string
	LocalPort    int
	Remote       string
	Attempt      int
	Error        string
	OpenedAt     int64

	// fingerprint 是当前 HostSpec 的摘要；配置变化时 Apply 会重建宿主。
	// 小写字段不会被 JSON 序列化，也不会进入日志。
	fingerprint string
	// done 在 run goroutine 完全退出（宿主已关闭）后关闭；Apply 替换配置时
	// 先等旧宿主让出端口，再启动新宿主，避免自己和自己抢监听端口。
	done chan struct{}
}

const (
	hostStatePending      = "pending"
	hostStateReady        = "ready"
	hostStateDisconnected = "disconnected"
)

// hostBackoff 是重试间隔；与 sshtunnel 的退避序列保持同一节奏。
var hostBackoff = []time.Duration{2 * time.Second, 5 * time.Second, 10 * time.Second, 30 * time.Second, 60 * time.Second}

// hostRestartDrainTimeout 是配置变化时等待旧宿主关闭的上限。
// 正常关闭是毫秒级；给 10s 是为了容忍正在建立 SSH 的连接。
const hostRestartDrainTimeout = 10 * time.Second

// NewHostSupervisor 构造监督器；opener 为空时使用 OpenHost。
func NewHostSupervisor(opener HostOpener) *HostSupervisor {
	if opener == nil {
		opener = OpenHost
	}
	return &HostSupervisor{opener: opener, now: time.Now, hosts: map[string]*HostStatus{}}
}

// hostSpecFingerprint 把会影响宿主的配置压成稳定摘要。
//
// 凭据只参与哈希，不落盘、不写状态；Label 变化也会触发一次重建，代价很小，
// 换来的是「所有连接字段改动都能生效」这条简单规则。
func hostSpecFingerprint(spec HostSpec) string {
	data, err := json.Marshal(spec)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// Apply 让运行中的宿主集合与 specs 一致：新增的启动，消失的关闭，配置变化的
// 重建。
//
// 它不等待宿主建立完成——宿主在各自 goroutine 里建立与重建，状态通过 Status
// 观察；但配置变化时会最多等 10s 让旧宿主关闭，避免同端口自抢。
// ctx 会交给宿主 goroutine，取消 ctx 会关闭宿主；常驻调用方必须传服务生命周期
// 的 ctx，不能传单轮探测的超时 ctx。
func (supervisor *HostSupervisor) Apply(ctx context.Context, specs []HostSpec, homeDir string) {
	if supervisor == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	desired := make(map[string]HostSpec, len(specs))
	fingerprints := make(map[string]string, len(specs))
	for _, spec := range specs {
		if id := strings.TrimSpace(spec.Connection.ID); id != "" {
			desired[id] = spec
			fingerprints[id] = hostSpecFingerprint(spec)
		}
	}
	supervisor.mu.Lock()
	if supervisor.closed {
		supervisor.mu.Unlock()
		return
	}
	// 关闭不再需要或配置已变化的宿主。删除后旧的 run goroutine 会通过
	// 状态指针发现「自己已被替换」并退出，不会误删新状态。
	stale := make([]*HostStatus, 0)
	for id, status := range supervisor.hosts {
		_, keep := desired[id]
		if !keep || status.fingerprint != fingerprints[id] {
			delete(supervisor.hosts, id)
			stale = append(stale, status)
		}
	}
	supervisor.mu.Unlock()
	// 等旧宿主真正关闭再启动同端口的替代者；否则新宿主会先撞上
	// "address already in use"，再白等一轮退避。
	supervisor.waitForHosts(stale, hostRestartDrainTimeout)

	for id, spec := range desired {
		supervisor.mu.Lock()
		if supervisor.closed {
			// waitForHosts 期间可能已经开始 Close；不要再往已关闭的监督器里加宿主。
			supervisor.mu.Unlock()
			return
		}
		if existing := supervisor.hosts[id]; existing != nil {
			if existing.fingerprint == fingerprints[id] {
				supervisor.mu.Unlock()
				continue
			}
			delete(supervisor.hosts, id)
		}
		status := &HostStatus{
			ConnectionID: id,
			State:        hostStatePending,
			LocalPort:    spec.ListenPort,
			Remote:       firstNonEmpty(strings.TrimSpace(spec.RemoteAddress), DefaultRemoteExecServerAddress),
			fingerprint:  fingerprints[id],
			done:         make(chan struct{}),
		}
		supervisor.hosts[id] = status
		supervisor.wg.Add(1)
		supervisor.mu.Unlock()

		go supervisor.run(ctx, spec, status, homeDir)
	}
}

// run 维持单条宿主：建立、保活、断线退避重建，直到 context 取消或被 Apply 移除。
func (supervisor *HostSupervisor) run(ctx context.Context, spec HostSpec, status *HostStatus, homeDir string) {
	defer func() {
		close(status.done)
		supervisor.wg.Done()
	}()
	attempt := 0
	for {
		if ctx.Err() != nil {
			return
		}
		if !supervisor.current(status) {
			// 已被 Apply 移除或被同 ID 的新配置替换；旧宿主由本 goroutine 关闭。
			return
		}
		host, err := supervisor.opener(ctx, HostOptions{
			Connection:    spec.Connection,
			RemoteAddress: spec.RemoteAddress,
			HomeDir:       homeDir,
			ListenPort:    spec.ListenPort,
			BearerToken:   spec.BearerToken,
			Cwd:           spec.Cwd,
			CodexPath:     spec.CodexPath,
		})
		if err != nil {
			attempt++
			supervisor.setStatus(status, func(s *HostStatus) {
				s.State = hostStateDisconnected
				s.Attempt = attempt
				s.Error = err.Error()
			})
			if !supervisor.sleep(ctx, attempt) {
				return
			}
			continue
		}
		attempt = 0
		supervisor.setStatus(status, func(s *HostStatus) {
			s.State = hostStateReady
			s.Attempt = 0
			s.Error = ""
			s.LocalPort = host.LocalPort()
			s.OpenedAt = supervisor.now().UnixMilli()
		})
		// 等 context 取消、该宿主被移除或被同 ID 的新配置替换；任一发生就关闭。
		supervisor.waitUntilRemoved(ctx, status)
		_ = host.Close()
		supervisor.mu.Lock()
		stillCurrent := supervisor.hosts[spec.Connection.ID] == status
		supervisor.mu.Unlock()
		if !stillCurrent {
			return
		}
	}
}

// current 判断 status 是否仍是该连接当前生效的那一份。
//
// 不能用「连接 ID 还在 map 里」判断：配置变化时 Apply 会删除旧状态并立刻
// 放入同 ID 的新状态；旧 goroutine 必须靠指针身份退出，否则会和新的宿主
// 并发运行，甚至把新状态删掉。
func (supervisor *HostSupervisor) current(status *HostStatus) bool {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if supervisor.closed {
		return false
	}
	return supervisor.hosts[status.ConnectionID] == status
}

// waitForHosts 等这些旧状态的 run goroutine 关闭宿主；超时后交给新宿主的
// 重试逻辑兜底，不能无限阻塞对账。
func (supervisor *HostSupervisor) waitForHosts(statuses []*HostStatus, timeout time.Duration) {
	if len(statuses) == 0 {
		return
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for _, status := range statuses {
		if status == nil || status.done == nil {
			continue
		}
		select {
		case <-status.done:
		case <-timer.C:
			return
		}
	}
}

func (supervisor *HostSupervisor) waitUntilRemoved(ctx context.Context, status *HostStatus) {
	// 配置替换时 Apply 会等 done，不能等 2s 才让出端口。
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if !supervisor.current(status) {
				return
			}
		}
	}
}

func (supervisor *HostSupervisor) sleep(ctx context.Context, attempt int) bool {
	delay := hostBackoff[len(hostBackoff)-1]
	if attempt-1 < len(hostBackoff) && attempt-1 >= 0 {
		delay = hostBackoff[attempt-1]
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (supervisor *HostSupervisor) setStatus(status *HostStatus, mutate func(*HostStatus)) {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if current, ok := supervisor.hosts[status.ConnectionID]; ok && current == status {
		mutate(status)
	}
}

// Status 返回当前宿主状态快照，按连接 ID 排序。
func (supervisor *HostSupervisor) Status() []HostStatus {
	if supervisor == nil {
		return nil
	}
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	out := make([]HostStatus, 0, len(supervisor.hosts))
	for _, status := range supervisor.hosts {
		out = append(out, *status)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ConnectionID < out[j].ConnectionID })
	return out
}

// Close 停止全部宿主并等待 goroutine 退出；幂等。
func (supervisor *HostSupervisor) Close() error {
	if supervisor == nil {
		return nil
	}
	supervisor.mu.Lock()
	if supervisor.closed {
		supervisor.mu.Unlock()
		return nil
	}
	supervisor.closed = true
	supervisor.hosts = map[string]*HostStatus{}
	supervisor.mu.Unlock()
	supervisor.wg.Wait()
	return nil
}
