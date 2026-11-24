package codexenvironments

import (
	"context"
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
}

const (
	hostStatePending      = "pending"
	hostStateReady        = "ready"
	hostStateDisconnected = "disconnected"
)

// hostBackoff 是重试间隔；与 sshtunnel 的退避序列保持同一节奏。
var hostBackoff = []time.Duration{2 * time.Second, 5 * time.Second, 10 * time.Second, 30 * time.Second, 60 * time.Second}

// NewHostSupervisor 构造监督器；opener 为空时使用 OpenHost。
func NewHostSupervisor(opener HostOpener) *HostSupervisor {
	if opener == nil {
		opener = OpenHost
	}
	return &HostSupervisor{opener: opener, now: time.Now, hosts: map[string]*HostStatus{}}
}

// Apply 让运行中的宿主集合与 specs 一致：新增的启动，消失的关闭，其余保持。
//
// 它不做阻塞等待——宿主在各自 goroutine 里建立与重建，状态通过 Status 观察。
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
	for _, spec := range specs {
		if id := strings.TrimSpace(spec.Connection.ID); id != "" {
			desired[id] = spec
		}
	}
	supervisor.mu.Lock()
	if supervisor.closed {
		supervisor.mu.Unlock()
		return
	}
	// 关闭不再需要的宿主。
	for id := range supervisor.hosts {
		if _, keep := desired[id]; !keep {
			delete(supervisor.hosts, id)
		}
	}
	supervisor.mu.Unlock()

	for id, spec := range desired {
		supervisor.mu.Lock()
		if _, running := supervisor.hosts[id]; running {
			supervisor.mu.Unlock()
			continue
		}
		status := &HostStatus{
			ConnectionID: id,
			State:        hostStatePending,
			LocalPort:    spec.ListenPort,
			Remote:       firstNonEmpty(strings.TrimSpace(spec.RemoteAddress), DefaultRemoteExecServerAddress),
		}
		supervisor.hosts[id] = status
		supervisor.wg.Add(1)
		supervisor.mu.Unlock()

		go supervisor.run(ctx, spec, status, homeDir)
	}
}

// run 维持单条宿主：建立、保活、断线退避重建，直到 context 取消或被 Apply 移除。
func (supervisor *HostSupervisor) run(ctx context.Context, spec HostSpec, status *HostStatus, homeDir string) {
	defer supervisor.wg.Done()
	attempt := 0
	for {
		if ctx.Err() != nil {
			return
		}
		if !supervisor.tracked(spec.Connection.ID) {
			// 已被 Apply 移除；若宿主已建立由外层关闭。
			supervisor.mu.Lock()
			delete(supervisor.hosts, spec.Connection.ID)
			supervisor.mu.Unlock()
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
			supervisor.setStatus(spec.Connection.ID, func(s *HostStatus) {
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
		supervisor.setStatus(spec.Connection.ID, func(s *HostStatus) {
			s.State = hostStateReady
			s.Attempt = 0
			s.Error = ""
			s.LocalPort = host.LocalPort()
			s.OpenedAt = supervisor.now().UnixMilli()
		})
		// 等 context 取消或该宿主被移除；两者任一发生就关闭。
		supervisor.waitUntilRemoved(ctx, spec.Connection.ID)
		_ = host.Close()
		supervisor.mu.Lock()
		_, stillTracked := supervisor.hosts[spec.Connection.ID]
		supervisor.mu.Unlock()
		if !stillTracked {
			return
		}
	}
}

func (supervisor *HostSupervisor) tracked(connectionID string) bool {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if supervisor.closed {
		return false
	}
	_, ok := supervisor.hosts[connectionID]
	return ok
}

func (supervisor *HostSupervisor) waitUntilRemoved(ctx context.Context, connectionID string) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if !supervisor.tracked(connectionID) {
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

func (supervisor *HostSupervisor) setStatus(connectionID string, mutate func(*HostStatus)) {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if status, ok := supervisor.hosts[connectionID]; ok {
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
