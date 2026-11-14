package pluginhost

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	appplugins "github.com/madou1217/ai_home/application/pluginruntime"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

const (
	defaultRecycleAfterGenerations = 32
	defaultRetireTimeout           = 10 * time.Minute
	defaultTicketTTL               = 30 * time.Second
	maxExpiredTickets              = 16
	maxFailureRecords              = 20
)

// DefaultBackoffSchedule 与 Node DEFAULT_BACKOFF_MS ([500, 1000, 2000, 5000, 10000]) 对齐。
var DefaultBackoffSchedule = []time.Duration{
	500 * time.Millisecond,
	1000 * time.Millisecond,
	2000 * time.Millisecond,
	5000 * time.Millisecond,
	10000 * time.Millisecond,
}

// RuntimeOptions 配置插件宿主代次运行时。
type RuntimeOptions struct {
	AIHomeDir               string
	RepoRoot                string
	SocketPath              string
	HostVersion             string
	NodePath                string
	NodeArgs                []string
	EntryPath               string
	HooksPath               string
	Registry                *appplugins.Registry
	SupervisorFactory       func(seq int64) (HostClient, error)
	DesiredPlugins          func(ctx context.Context) ([]PluginSpec, error)
	ResolveHandler          HandlerResolver
	OnProviderDescriptors   func(DescriptorCollectResult)
	OnRuntimeChange         func()
	OnLog                   func(string)
	RecycleAfterGenerations int
	RetireTimeout           time.Duration
	TicketTTL               time.Duration
	BackoffSchedule         []time.Duration
	MaxConsecutiveFailures  int
}

// RuntimeTicket 描述一次 prepare 成功后持有的候选代次发布票据。
type RuntimeTicket struct {
	Ticket        string
	Generation    int64
	Contributions []string
}

// GenerationSnapshot 保存单个存活代次的不可变贡献投影与已收集目录元数据。
type GenerationSnapshot struct {
	Generation     int64
	Projection     appplugins.Projection
	CatalogAliases []CatalogAlias
	Descriptors    DescriptorCollectResult
}

// Lease 固定当前活跃代次，保证请求期间代次不会被释放。Release 幂等。
type Lease struct {
	Generation int64
	Snapshot   GenerationSnapshot
	runtime    *Runtime
	mu         sync.Mutex
	released   bool
}

// Release 释放代次租约；若该代次处于排空中且租约归零，则触发异步卸载。
func (l *Lease) Release() {
	if l == nil || l.runtime == nil {
		return
	}
	l.mu.Lock()
	if l.released {
		l.mu.Unlock()
		return
	}
	l.released = true
	l.mu.Unlock()
	l.runtime.releaseLease(l.Generation)
}

type pendingCandidate struct {
	id            string
	empty         bool
	generation    int64
	snapshot      GenerationSnapshot
	contributions []string
	createdAt     time.Time
	timer         *time.Timer
	host          HostClient
}

// Runtime 管理 Plugin Host 子进程、代次准备/激活/排空回收、崩溃退避恢复及 Go Registry 投影同步。
type Runtime struct {
	options                 RuntimeOptions
	registry                *appplugins.Registry
	recycleAfterGenerations int
	retireTimeout           time.Duration
	ticketTTL               time.Duration
	backoffSchedule         []time.Duration
	maxConsecutiveFailures  int

	hookMu sync.RWMutex
	// opMu 串行化 Start/Stop/Prepare/Activate/Discard/Publish/Recover 等代次状态转换。
	opMu sync.Mutex

	// mu 保护内存态快照、票据、租约与统计字段；切勿在持有 mu 时发 RPC 或同步回调外部。
	mu                  sync.Mutex
	host                HostClient
	hostSeq             int64
	state               RuntimeState
	generation          int64
	activeSnapshot      GenerationSnapshot
	liveSnapshots       map[int64]GenerationSnapshot
	desiredCount        int
	generationsOnHost   int
	diagnostics         []PrepareDiagnostic
	lastError           *FailureRecord
	recentFailures      []FailureRecord
	consecutiveFailures int
	forcedRetirements   int
	pending             *pendingCandidate
	expiredTickets      []string
	expiredSet          map[string]bool
	leases              map[int64]int
	retiring            map[int64]*time.Timer
	restartTimer        *time.Timer
	stoppingHost        bool
	stopped             bool

	bgWG sync.WaitGroup
}

// NewRuntime 创建插件代次运行时服务。
func NewRuntime(options RuntimeOptions) (*Runtime, error) {
	registry := options.Registry
	if registry == nil {
		registry = appplugins.NewRegistry()
	}
	recycle := options.RecycleAfterGenerations
	if recycle <= 0 {
		recycle = defaultRecycleAfterGenerations
	}
	retireTimeout := options.RetireTimeout
	if retireTimeout <= 0 {
		retireTimeout = defaultRetireTimeout
	}
	ticketTTL := options.TicketTTL
	if ticketTTL <= 0 {
		ticketTTL = defaultTicketTTL
	}
	backoff := options.BackoffSchedule
	if len(backoff) == 0 {
		backoff = append([]time.Duration(nil), DefaultBackoffSchedule...)
	}
	maxFail := options.MaxConsecutiveFailures
	if maxFail <= 0 {
		maxFail = len(backoff)
	}
	return &Runtime{
		options:                 options,
		registry:                registry,
		recycleAfterGenerations: recycle,
		retireTimeout:           retireTimeout,
		ticketTTL:               ticketTTL,
		backoffSchedule:         backoff,
		maxConsecutiveFailures:  maxFail,
		state:                   StateIdle,
		liveSnapshots:           make(map[int64]GenerationSnapshot),
		expiredSet:              make(map[string]bool),
		leases:                  make(map[int64]int),
		retiring:                make(map[int64]*time.Timer),
	}, nil
}

// Registry 返回运行时同步的目标投影注册表。
func (r *Runtime) Registry() *appplugins.Registry {
	if r == nil {
		return nil
	}
	return r.registry
}

// Start 根据 DesiredPlugins 发布初始代次（若无启用插件则保持 idle，不启动宿主进程）。
func (r *Runtime) Start(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	desiredFn := r.desiredPluginsFunc()
	if desiredFn == nil {
		return nil
	}
	plugins, err := desiredFn(ctx)
	if err != nil {
		r.recordFailure(errorCodeOr(err, CodeRuntimeUnavailable), err.Error(), "", nil)
		r.mu.Lock()
		r.state = StateDegraded
		r.mu.Unlock()
		return err
	}
	_, err = r.Publish(ctx, plugins, nil)
	return err
}

// PushDesired 重新加载 DesiredPlugins 并发布为最新活跃代次。
func (r *Runtime) PushDesired(ctx context.Context) error {
	return r.Start(ctx)
}

// Stop 停机：撤销全部定时器、清理票据与代次、关闭宿主子进程并清空 Go 投影注册表。
func (r *Runtime) Stop(ctx context.Context) error {
	if r == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	r.opMu.Lock()
	r.mu.Lock()
	if r.stopped {
		r.mu.Unlock()
		r.opMu.Unlock()
		return nil
	}
	r.stopped = true
	r.state = StateStopping
	if r.restartTimer != nil {
		r.restartTimer.Stop()
		r.restartTimer = nil
	}
	if r.pending != nil {
		if r.pending.timer != nil {
			r.pending.timer.Stop()
		}
		r.pending = nil
	}
	for gen, timer := range r.retiring {
		if timer != nil {
			timer.Stop()
		}
		delete(r.retiring, gen)
	}
	r.activeSnapshot = GenerationSnapshot{}
	r.liveSnapshots = make(map[int64]GenerationSnapshot)
	r.leases = make(map[int64]int)
	r.generationsOnHost = 0
	host := r.host
	r.host = nil
	r.stoppingHost = true
	r.mu.Unlock()

	if host != nil {
		_ = host.Stop(ctx)
	}

	r.mu.Lock()
	r.stoppingHost = false
	r.state = StateStopped
	r.mu.Unlock()
	r.opMu.Unlock()

	_, _ = r.registry.Replace(appplugins.HostAccess{}, nil, nil)
	if r.options.OnProviderDescriptors != nil {
		r.options.OnProviderDescriptors(DescriptorCollectResult{})
	}
	r.notifyChange()
	r.bgWG.Wait()
	return nil
}

// Prepare 校验依赖图并在宿主进程内准备候选代次，返回独占发布票据。
func (r *Runtime) Prepare(ctx context.Context, plugins []PluginSpec) (RuntimeTicket, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	r.opMu.Lock()
	defer r.opMu.Unlock()

	return r.prepareLocked(ctx, plugins)
}

func (r *Runtime) prepareLocked(ctx context.Context, plugins []PluginSpec) (RuntimeTicket, error) {
	r.mu.Lock()
	if r.stopped {
		r.mu.Unlock()
		return RuntimeTicket{}, pluginerr.New(CodeRuntimeUnavailable, "插件运行时已停止")
	}
	if r.pending != nil {
		r.mu.Unlock()
		return RuntimeTicket{}, pluginerr.New(CodePublishBusy, "另一个插件发布正在进行中")
	}
	r.desiredCount = len(plugins)
	r.mu.Unlock()

	if len(plugins) == 0 {
		ticketID := newTicketID()
		p := &pendingCandidate{
			id:        ticketID,
			empty:     true,
			createdAt: time.Now(),
		}
		r.armPendingTicket(p)
		return RuntimeTicket{Ticket: ticketID, Generation: 0, Contributions: []string{}}, nil
	}

	if plan := PlanGeneration(plugins); !plan.OK {
		r.mu.Lock()
		r.diagnostics = append([]PrepareDiagnostic(nil), plan.Diagnostics...)
		if r.activeSnapshot.Generation == 0 {
			r.state = StateDegraded
		}
		r.mu.Unlock()
		return RuntimeTicket{}, newCandidateRejectedError(formatDiagnosticsSummary(plan.Diagnostics), plan.Diagnostics)
	}

	// 若当前宿主已达到代次回收阈值且没有任何在途租约，先停掉旧宿主再由新宿主加载候选代次。
	r.mu.Lock()
	needRecycle := r.host != nil && r.generationsOnHost >= r.recycleAfterGenerations && r.totalLeasesLocked() == 0
	r.mu.Unlock()
	if needRecycle {
		r.stopHostLocked(ctx)
	}

	host, err := r.ensureSupervisorLocked(ctx)
	if err != nil {
		r.markDegradedIfInactive(errorCodeOr(err, CodeRuntimeUnavailable), err.Error())
		return RuntimeTicket{}, pluginerr.New(CodeRuntimeUnavailable, err.Error())
	}

	r.mu.Lock()
	if r.activeSnapshot.Generation == 0 {
		r.state = StateStarting
	}
	r.generation++
	candidateGen := r.generation
	r.generationsOnHost++
	r.mu.Unlock()

	prepared, err := host.Prepare(ctx, candidateGen, plugins)
	if err != nil {
		code := errorCodeOr(err, CodeRuntimeUnavailable)
		r.recordFailure(code, err.Error(), "prepare", nil)
		r.markDegradedIfInactive(code, err.Error())
		return RuntimeTicket{}, pluginerr.New(firstNonEmpty(errorCode(err), CodeRuntimeUnavailable), err.Error())
	}
	if prepared.State != "prepared" {
		r.mu.Lock()
		r.diagnostics = append([]PrepareDiagnostic(nil), prepared.Diagnostics...)
		if r.activeSnapshot.Generation == 0 {
			r.state = StateDegraded
		}
		r.mu.Unlock()
		return RuntimeTicket{}, newCandidateRejectedError(formatDiagnosticsSummary(prepared.Diagnostics), prepared.Diagnostics)
	}

	draft := buildProjectionSnapshot(candidateGen, plugins)
	aliases, err := CollectCatalogAliases(ctx, draft, host.Invoke)
	if err != nil {
		_, _ = host.Dispose(context.Background(), candidateGen)
		var diags []PrepareDiagnostic
		if coded, ok := pluginerr.From(err); ok {
			for _, d := range coded.Diagnostics {
				if pd, ok := d.(PrepareDiagnostic); ok {
					diags = append(diags, pd)
				}
			}
		}
		r.mu.Lock()
		r.diagnostics = diags
		if r.activeSnapshot.Generation == 0 {
			r.state = StateDegraded
		}
		r.mu.Unlock()
		return RuntimeTicket{}, err
	}

	descResult, err := CollectProviderDescriptors(ctx, draft, host.Invoke, r.options.ResolveHandler)
	if err != nil {
		_, _ = host.Dispose(context.Background(), candidateGen)
		diag := PrepareDiagnostic{Code: firstNonEmpty(errorCode(err), CodeDescriptorCollectFailed), Detail: err.Error()}
		r.mu.Lock()
		r.diagnostics = []PrepareDiagnostic{diag}
		if r.activeSnapshot.Generation == 0 {
			r.state = StateDegraded
		}
		r.mu.Unlock()
		return RuntimeTicket{}, newCandidateRejectedError(err.Error(), []PrepareDiagnostic{diag})
	}

	snap := GenerationSnapshot{
		Generation:     candidateGen,
		Projection:     draft,
		CatalogAliases: aliases,
		Descriptors:    descResult,
	}
	ticketID := newTicketID()
	contribs := append([]string(nil), prepared.Contributions...)
	if contribs == nil {
		contribs = []string{}
	}
	p := &pendingCandidate{
		id:            ticketID,
		empty:         false,
		generation:    candidateGen,
		snapshot:      snap,
		contributions: contribs,
		createdAt:     time.Now(),
		host:          host,
	}
	r.armPendingTicket(p)
	return RuntimeTicket{
		Ticket:        ticketID,
		Generation:    candidateGen,
		Contributions: contribs,
	}, nil
}

// Activate 提交后激活票据对应的候选代次，并将实时投影同步写入 Go Registry。
func (r *Runtime) Activate(ctx context.Context, ticketID string, revision int64) (RuntimeStatus, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	r.opMu.Lock()
	defer r.opMu.Unlock()
	_ = revision
	return r.activateLocked(ctx, ticketID)
}

func (r *Runtime) activateLocked(ctx context.Context, ticketID string) (RuntimeStatus, error) {
	ticket, err := r.takeTicketLocked(ticketID)
	if err != nil {
		return RuntimeStatus{}, err
	}

	if ticket.empty {
		r.mu.Lock()
		prevGen := r.activeSnapshot.Generation
		r.activeSnapshot = GenerationSnapshot{}
		delete(r.liveSnapshots, 0)
		r.diagnostics = nil
		r.consecutiveFailures = 0
		r.state = StateIdle
		hasPrevLeases := prevGen > 0 && r.leases[prevGen] > 0
		r.mu.Unlock()

		if prevGen > 0 {
			if hasPrevLeases {
				r.retireLocked(ctx, prevGen)
			} else {
				r.stopHostLocked(ctx)
			}
		} else {
			r.stopHostLocked(ctx)
		}
		r.syncRegistry()
		if r.options.OnProviderDescriptors != nil {
			r.options.OnProviderDescriptors(DescriptorCollectResult{})
		}
		r.notifyChange()
		return r.Status(ctx), nil
	}

	host := ticket.host
	if host == nil {
		r.mu.Lock()
		host = r.host
		r.mu.Unlock()
	}
	if host == nil || !host.Running() {
		r.markDegradedIfInactive(CodeRuntimeUnavailable, "插件宿主不可用")
		return RuntimeStatus{}, pluginerr.New(CodeRuntimeUnavailable, "插件宿主不可用")
	}

	if _, err := host.Activate(ctx, ticket.generation, true); err != nil {
		_, _ = host.Dispose(context.Background(), ticket.generation)
		code := firstNonEmpty(errorCode(err), CodeRuntimeUnavailable)
		r.recordFailure(code, err.Error(), "activate", nil)
		r.markDegradedIfInactive(code, err.Error())
		return RuntimeStatus{}, pluginerr.New(code, err.Error())
	}

	r.mu.Lock()
	prevGen := r.activeSnapshot.Generation
	r.activeSnapshot = ticket.snapshot
	r.liveSnapshots[ticket.generation] = ticket.snapshot
	r.diagnostics = nil
	r.lastError = nil
	r.consecutiveFailures = 0
	r.state = StateActive
	r.mu.Unlock()

	if prevGen > 0 && prevGen != ticket.generation {
		r.retireLocked(ctx, prevGen)
	}
	r.syncRegistry()
	if r.options.OnProviderDescriptors != nil {
		r.options.OnProviderDescriptors(ticket.snapshot.Descriptors)
	}
	r.notifyChange()
	return r.Status(ctx), nil
}

// Discard 丢弃尚未激活的候选票据并释放发布锁。
func (r *Runtime) Discard(ctx context.Context, ticketID string, reason string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	_ = reason
	r.opMu.Lock()
	defer r.opMu.Unlock()
	return r.discardLocked(ctx, ticketID)
}

func (r *Runtime) discardLocked(ctx context.Context, ticketID string) error {
	ticket, err := r.takeTicketLocked(ticketID)
	if err != nil {
		return err
	}
	if !ticket.empty && ticket.host != nil && ticket.host.Running() {
		_, _ = ticket.host.Dispose(ctx, ticket.generation)
	}
	return nil
}

// Publish 组合 prepare -> optional commit -> activate；失败时自动 discard 释放票据。
func (r *Runtime) Publish(ctx context.Context, plugins []PluginSpec, commit func(context.Context) (int64, error)) (RuntimeStatus, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	r.opMu.Lock()
	defer r.opMu.Unlock()

	prepared, err := r.prepareLocked(ctx, plugins)
	if err != nil {
		return RuntimeStatus{}, err
	}
	var revision int64
	if commit != nil {
		revision, err = commit(ctx)
		if err != nil {
			_ = r.discardLocked(context.Background(), prepared.Ticket)
			return RuntimeStatus{}, err
		}
	}
	_ = revision
	status, err := r.activateLocked(ctx, prepared.Ticket)
	if err != nil {
		_ = r.discardLocked(context.Background(), prepared.Ticket)
		return RuntimeStatus{}, err
	}
	return status, nil
}

// Acquire 为请求固定当前活跃代次；若当前没有活跃插件代次返回 nil。
func (r *Runtime) Acquire() *Lease {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	gen := r.activeSnapshot.Generation
	if gen <= 0 || r.stopped {
		return nil
	}
	r.leases[gen]++
	return &Lease{
		Generation: gen,
		Snapshot:   r.activeSnapshot,
		runtime:    r,
	}
}

func (r *Runtime) tryBeginBG() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stopped {
		return false
	}
	r.bgWG.Add(1)
	return true
}

func (r *Runtime) releaseLease(gen int64) {
	r.mu.Lock()
	if r.stopped {
		r.mu.Unlock()
		return
	}
	cur := r.leases[gen]
	if cur <= 1 {
		delete(r.leases, gen)
	} else {
		r.leases[gen] = cur - 1
		r.mu.Unlock()
		return
	}
	timer, isRetiring := r.retiring[gen]
	if isRetiring {
		if timer != nil {
			timer.Stop()
		}
		delete(r.retiring, gen)
		r.bgWG.Add(1)
	}
	r.mu.Unlock()

	if isRetiring {
		go func() {
			defer r.bgWG.Done()
			r.opMu.Lock()
			defer r.opMu.Unlock()
			dispCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			r.disposeGenerationLocked(dispCtx, gen)
		}()
	}
}

// Invoke 在指定代次上通过活跃宿主调用插件贡献项，并在调用期间自动持有租约。
func (r *Runtime) Invoke(ctx context.Context, generation int64, contributionID string, value any, timeout time.Duration) (json.RawMessage, error) {
	raw, _, err := r.InvokeWithPayload(ctx, generation, contributionID, value, timeout)
	return raw, err
}

// InvokeWithPayload 与 Invoke 相同，但保留宿主附带的二进制 payload。
func (r *Runtime) InvokeWithPayload(ctx context.Context, generation int64, contributionID string, value any, timeout time.Duration) (json.RawMessage, []byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	lease := r.acquireForGeneration(generation)
	if lease == nil {
		return nil, nil, pluginerr.New(CodeRuntimeUnavailable, "目标代次未就绪或已卸载")
	}
	defer lease.Release()

	r.mu.Lock()
	host := r.host
	r.mu.Unlock()
	if host == nil || !host.Running() {
		return nil, nil, pluginerr.New(CodeRuntimeUnavailable, "插件宿主未运行")
	}
	if rawClient, ok := host.(HostRawClient); ok {
		return rawClient.InvokeRaw(ctx, lease.Generation, contributionID, value, timeout)
	}
	raw, err := host.Invoke(ctx, lease.Generation, contributionID, value, timeout)
	return raw, nil, err
}

func (r *Runtime) acquireForGeneration(generation int64) *Lease {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stopped {
		return nil
	}
	gen := generation
	if gen <= 0 {
		gen = r.activeSnapshot.Generation
	}
	if gen <= 0 {
		return nil
	}
	snap, ok := r.liveSnapshots[gen]
	if !ok {
		return nil
	}
	r.leases[gen]++
	return &Lease{
		Generation: gen,
		Snapshot:   snap,
		runtime:    r,
	}
}

// Status 返回插件运行时的完整诊断状态。
func (r *Runtime) Status(ctx context.Context) RuntimeStatus {
	r.mu.Lock()
	activeGen := r.activeSnapshot.Generation
	totalLeases := r.totalLeasesLocked()
	retiringCount := len(r.retiring)
	host := r.host
	pid := 0
	if host != nil {
		pid = host.PID()
	}
	var lastErrCopy *FailureRecord
	if r.lastError != nil {
		cp := *r.lastError
		lastErrCopy = &cp
	}
	descErrs := append([]DescriptorError(nil), r.activeSnapshot.Descriptors.Errors...)
	out := RuntimeStatus{
		State:               r.state,
		Generation:          r.generation,
		ActiveGeneration:    activeGen,
		DesiredPlugins:      r.desiredCount,
		HostPID:             pid,
		GenerationsOnHost:   r.generationsOnHost,
		RetiringCount:       retiringCount,
		ActiveLeases:        totalLeases,
		ConsecutiveFailures: r.consecutiveFailures,
		LastError:           lastErrCopy,
		RecentFailures:      append([]FailureRecord(nil), r.recentFailures...),
		Diagnostics:         append([]PrepareDiagnostic(nil), r.diagnostics...),
		DescriptorErrors:    descErrs,
	}
	r.mu.Unlock()

	if host != nil && host.Running() && ctx != nil {
		statusCtx, cancel := context.WithTimeout(ctx, time.Second)
		hostStatus, err := host.Status(statusCtx)
		cancel()
		if err == nil {
			out.HostStatus = &hostStatus
		}
	}
	return out
}

func (r *Runtime) ensureSupervisorLocked(ctx context.Context) (HostClient, error) {
	r.mu.Lock()
	existing := r.host
	r.mu.Unlock()
	if existing != nil {
		if !existing.Running() {
			if err := existing.Start(ctx); err != nil {
				return nil, err
			}
		}
		return existing, nil
	}

	r.mu.Lock()
	r.hostSeq++
	seq := r.hostSeq
	r.mu.Unlock()

	var client HostClient
	var err error
	if r.options.SupervisorFactory != nil {
		client, err = r.options.SupervisorFactory(seq)
	} else {
		socketPath := r.options.SocketPath
		if socketPath == "" && seq > 1 && r.options.AIHomeDir != "" && runtime.GOOS != "windows" {
			defaultSock := ResolvePluginSocket(r.options.AIHomeDir, runtime.GOOS)
			socketPath = strings.TrimSuffix(defaultSock, ".sock") + fmt.Sprintf("-r%d.sock", seq)
		}
		client, err = NewSupervisor(SupervisorOptions{
			AIHomeDir:   r.options.AIHomeDir,
			RepoRoot:    r.options.RepoRoot,
			SocketPath:  socketPath,
			HostVersion: r.options.HostVersion,
			NodePath:    r.options.NodePath,
			NodeArgs:    r.options.NodeArgs,
			EntryPath:   r.options.EntryPath,
			HooksPath:   r.options.HooksPath,
			OnLog:       r.options.OnLog,
			OnExit:      func(evt ExitEvent) { r.handleUnexpectedExit(client, evt) },
		})
	}
	if err != nil {
		return nil, err
	}
	if err := client.Start(ctx); err != nil {
		_ = client.Stop(context.Background())
		return nil, err
	}

	r.mu.Lock()
	if r.stopped {
		r.mu.Unlock()
		_ = client.Stop(context.Background())
		return nil, pluginerr.New(CodeRuntimeUnavailable, "插件运行时已停止")
	}
	r.host = client
	r.generationsOnHost = 0
	r.mu.Unlock()
	return client, nil
}

func (r *Runtime) stopHostLocked(ctx context.Context) {
	r.mu.Lock()
	host := r.host
	r.host = nil
	r.stoppingHost = true
	r.generationsOnHost = 0
	for gen, timer := range r.retiring {
		if timer != nil {
			timer.Stop()
		}
		delete(r.retiring, gen)
	}
	r.liveSnapshots = make(map[int64]GenerationSnapshot)
	r.leases = make(map[int64]int)
	if r.activeSnapshot.Generation > 0 {
		r.liveSnapshots[r.activeSnapshot.Generation] = r.activeSnapshot
	}
	r.mu.Unlock()

	if host != nil {
		_ = host.Stop(ctx)
	}

	r.mu.Lock()
	r.stoppingHost = false
	r.mu.Unlock()
}

func (r *Runtime) retireLocked(ctx context.Context, prevGen int64) {
	if prevGen <= 0 {
		return
	}
	r.mu.Lock()
	hasLeases := r.leases[prevGen] > 0
	if hasLeases {
		if _, exists := r.retiring[prevGen]; !exists {
			r.retiring[prevGen] = time.AfterFunc(r.retireTimeout, func() {
				if !r.tryBeginBG() {
					return
				}
				defer r.bgWG.Done()
				r.opMu.Lock()
				defer r.opMu.Unlock()
				r.mu.Lock()
				r.forcedRetirements++
				r.mu.Unlock()
				dispCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				r.disposeGenerationLocked(dispCtx, prevGen)
			})
		}
		r.mu.Unlock()
		return
	}
	r.mu.Unlock()
	r.disposeGenerationLocked(ctx, prevGen)
}

func (r *Runtime) disposeGenerationLocked(ctx context.Context, gen int64) {
	r.mu.Lock()
	if r.stopped {
		r.mu.Unlock()
		return
	}
	if timer, ok := r.retiring[gen]; ok {
		if timer != nil {
			timer.Stop()
		}
		delete(r.retiring, gen)
	}
	delete(r.leases, gen)
	_, removed := r.liveSnapshots[gen]
	delete(r.liveSnapshots, gen)
	host := r.host
	shouldStopHost := r.activeSnapshot.Generation == 0 && r.totalLeasesLocked() == 0 && r.pending == nil
	r.mu.Unlock()

	if host != nil && host.Running() {
		_, _ = host.Dispose(ctx, gen)
	}
	if removed {
		r.syncRegistry()
		r.notifyChange()
	}
	if shouldStopHost {
		r.stopHostLocked(ctx)
		r.syncRegistry()
	}
}

func (r *Runtime) handleUnexpectedExit(exitedHost HostClient, evt ExitEvent) {
	r.mu.Lock()
	if r.stopped || r.stoppingHost || r.host != exitedHost {
		r.mu.Unlock()
		return
	}
	r.host = nil
	r.generationsOnHost = 0
	activeWasPresent := r.activeSnapshot.Generation > 0 || r.desiredCount > 0
	r.activeSnapshot = GenerationSnapshot{}
	r.liveSnapshots = make(map[int64]GenerationSnapshot)
	r.leases = make(map[int64]int)
	for gen, timer := range r.retiring {
		if timer != nil {
			timer.Stop()
		}
		delete(r.retiring, gen)
	}
	if r.pending != nil && r.pending.host == exitedHost {
		if r.pending.timer != nil {
			r.pending.timer.Stop()
		}
		r.pending = nil
	}
	if activeWasPresent {
		r.state = StateDegraded
	} else {
		r.state = StateIdle
	}
	r.mu.Unlock()

	r.recordFailure(CodeHostExited, formatExitDetail("插件宿主意外退出", &evt), evt.Stderr, evt.Code)
	_, _ = r.registry.Replace(appplugins.HostAccess{}, nil, nil)
	if r.options.OnProviderDescriptors != nil {
		r.options.OnProviderDescriptors(DescriptorCollectResult{})
	}
	r.notifyChange()

	if activeWasPresent {
		r.scheduleRecovery()
	}
}

func (r *Runtime) scheduleRecovery() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stopped || r.restartTimer != nil {
		return
	}
	if r.consecutiveFailures >= r.maxConsecutiveFailures {
		r.state = StateDegraded
		return
	}
	idx := r.consecutiveFailures
	if idx >= len(r.backoffSchedule) {
		idx = len(r.backoffSchedule) - 1
	}
	delay := r.backoffSchedule[idx]
	r.restartTimer = time.AfterFunc(delay, func() {
		if !r.tryBeginBG() {
			return
		}
		defer r.bgWG.Done()
		r.mu.Lock()
		r.restartTimer = nil
		r.mu.Unlock()
		desiredFn := r.desiredPluginsFunc()
		if desiredFn == nil {
			return
		}
		plugins, err := desiredFn(context.Background())
		if err == nil {
			_, err = r.Publish(context.Background(), plugins, nil)
		}
		if err != nil {
			r.mu.Lock()
			r.consecutiveFailures++
			r.state = StateDegraded
			r.mu.Unlock()
			r.recordFailure(errorCodeOr(err, CodeHostStartFailed), err.Error(), "recover", nil)
			r.scheduleRecovery()
		}
	})
}

func (r *Runtime) armPendingTicket(p *pendingCandidate) {
	r.mu.Lock()
	defer r.mu.Unlock()
	p.timer = time.AfterFunc(r.ticketTTL, func() {
		if !r.tryBeginBG() {
			return
		}
		defer r.bgWG.Done()
		r.opMu.Lock()
		defer r.opMu.Unlock()
		r.mu.Lock()
		if r.pending != p || r.stopped {
			r.mu.Unlock()
			return
		}
		r.pending = nil
		r.recordExpiredTicketLocked(p.id)
		r.mu.Unlock()
		if !p.empty && p.host != nil && p.host.Running() {
			_, _ = p.host.Dispose(context.Background(), p.generation)
		}
	})
	r.pending = p
}

func (r *Runtime) takeTicketLocked(ticketID string) (*pendingCandidate, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.pending != nil && r.pending.id == ticketID {
		p := r.pending
		r.pending = nil
		if p.timer != nil {
			p.timer.Stop()
		}
		return p, nil
	}
	if r.expiredSet[ticketID] {
		return nil, pluginerr.New(CodeTicketExpired, "发布票据已过期，请重新准备候选代次")
	}
	return nil, pluginerr.New(CodeTicketUnknown, "发布票据不存在或已消费")
}

func (r *Runtime) recordExpiredTicketLocked(id string) {
	if r.expiredSet[id] {
		return
	}
	r.expiredSet[id] = true
	r.expiredTickets = append(r.expiredTickets, id)
	for len(r.expiredTickets) > maxExpiredTickets {
		old := r.expiredTickets[0]
		r.expiredTickets = r.expiredTickets[1:]
		delete(r.expiredSet, old)
	}
}

func (r *Runtime) syncRegistry() {
	r.mu.Lock()
	host := r.host
	projections := make([]appplugins.Projection, 0, len(r.liveSnapshots))
	for _, snap := range r.liveSnapshots {
		if snap.Projection.Generation > 0 {
			projections = append(projections, snap.Projection)
		}
	}
	r.mu.Unlock()

	sort.Slice(projections, func(i, j int) bool {
		return projections[i].Generation < projections[j].Generation
	})
	if len(projections) == 0 || host == nil {
		_, _ = r.registry.Replace(appplugins.HostAccess{}, nil, nil)
		return
	}
	access := appplugins.HostAccess{
		Address: host.SocketPath(),
		Token:   host.Token(),
	}
	_, _ = r.registry.Replace(access, projections, nil)
}

func (r *Runtime) SetDesiredPluginsFunc(fn func(context.Context) ([]PluginSpec, error)) {
	r.hookMu.Lock()
	r.options.DesiredPlugins = fn
	r.hookMu.Unlock()
}

func (r *Runtime) SetOnRuntimeChange(fn func()) {
	r.hookMu.Lock()
	r.options.OnRuntimeChange = fn
	r.hookMu.Unlock()
}

func (r *Runtime) desiredPluginsFunc() func(context.Context) ([]PluginSpec, error) {
	r.hookMu.RLock()
	fn := r.options.DesiredPlugins
	r.hookMu.RUnlock()
	return fn
}

func (r *Runtime) notifyChange() {
	r.hookMu.RLock()
	fn := r.options.OnRuntimeChange
	r.hookMu.RUnlock()
	if fn != nil {
		fn()
	}
}

func (r *Runtime) markDegradedIfInactive(code, message string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.activeSnapshot.Generation == 0 && !r.stopped {
		r.state = StateDegraded
	}
	if message != "" {
		r.lastError = &FailureRecord{
			At:      time.Now().UTC().Format(time.RFC3339Nano),
			Code:    code,
			Message: message,
		}
	}
}

func (r *Runtime) recordFailure(code, message, detail string, exitCode *int) {
	rec := FailureRecord{
		At:       time.Now().UTC().Format(time.RFC3339Nano),
		Code:     firstNonEmpty(code, CodeRuntimeUnavailable),
		Message:  message,
		Detail:   detail,
		ExitCode: exitCode,
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lastError = &rec
	r.recentFailures = append(r.recentFailures, rec)
	if len(r.recentFailures) > maxFailureRecords {
		r.recentFailures = r.recentFailures[len(r.recentFailures)-maxFailureRecords:]
	}
}

func (r *Runtime) totalLeasesLocked() int {
	total := 0
	for _, n := range r.leases {
		total += n
	}
	return total
}

func buildProjectionSnapshot(generation int64, plugins []PluginSpec) appplugins.Projection {
	items := make([]appplugins.Contribution, 0)
	for _, p := range plugins {
		for _, contrib := range mapSlice(p.Manifest, "contributes") {
			id := stringField(contrib, "id")
			capName := stringField(contrib, "capability")
			if id == "" || capName == "" {
				continue
			}
			order := 0
			if ord, ok := asFiniteFloat(contrib["order"]); ok {
				order = int(ord)
			}
			policy := "deny"
			if stringField(contrib, "failurePolicy") == "delegate" {
				policy = "delegate"
			}
			items = append(items, appplugins.Contribution{
				ID:            id,
				Capability:    capName,
				Order:         order,
				FailurePolicy: policy,
				InstanceID:    p.InstanceID,
			})
		}
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].Order != items[j].Order {
			return items[i].Order < items[j].Order
		}
		if items[i].InstanceID != items[j].InstanceID {
			return items[i].InstanceID < items[j].InstanceID
		}
		return items[i].ID < items[j].ID
	})
	return appplugins.Projection{
		Generation:    generation,
		Contributions: items,
	}
}

func formatDiagnosticsSummary(diags []PrepareDiagnostic) string {
	if len(diags) == 0 {
		return "候选代次被拒绝"
	}
	parts := make([]string, 0, len(diags))
	for _, d := range diags {
		parts = append(parts, firstNonEmpty(d.Detail, d.Code))
	}
	return strings.Join(parts, "；")
}

func errorCodeOr(err error, fallback string) string {
	if code := errorCode(err); code != "" {
		return code
	}
	return fallback
}

func newTicketID() string {
	buf := make([]byte, 16)
	_, _ = rand.Read(buf)
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		hex.EncodeToString(buf[0:4]),
		hex.EncodeToString(buf[4:6]),
		hex.EncodeToString(buf[6:8]),
		hex.EncodeToString(buf[8:10]),
		hex.EncodeToString(buf[10:16]),
	)
}
