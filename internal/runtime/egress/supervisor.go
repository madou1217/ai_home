package egress

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	// DefaultStartupTimeout 与 Node STARTUP_TIMEOUT_MS 对齐（15s）。
	DefaultStartupTimeout = 15 * time.Second
	// DefaultStartupPollInterval 与 Node STARTUP_POLL_INTERVAL_MS 对齐（200ms）。
	DefaultStartupPollInterval = 200 * time.Millisecond
	// DefaultSwitchSettleDelay 与 Node SWITCH_SETTLE_MS 对齐（120ms）。
	DefaultSwitchSettleDelay = 120 * time.Millisecond
	// DefaultReapTimeout 与 Node REAP_TIMEOUT_MS 对齐（3s）。
	DefaultReapTimeout = 3 * time.Second
	// DefaultStartRetryBackoff 与 Node START_RETRY_BACKOFF_MS 对齐（60s）。
	DefaultStartRetryBackoff = 60 * time.Second
	// DefaultPlanInterval 与 Node EGRESS_POOL_PLAN_INTERVAL_MS 对齐（60s）。
	DefaultPlanInterval = 60 * time.Second
	// DefaultGeoPerTick 与 Node GEO_PER_TICK 对齐（12）。
	DefaultGeoPerTick = 12
	// DefaultProbesPerTick 与 Node PROBES_PER_TICK 对齐（6）。
	DefaultProbesPerTick = 6
	// ReconcileEveryGeoUpdates 与 Node RECONCILE_EVERY 对齐（每补 4 个节点位置重排一次车道）。
	ReconcileEveryGeoUpdates = 4
	// InitialReadyGeoLimit / InitialReadyProbeLimit 与 server.js 池就绪首轮补全对齐。
	InitialReadyGeoLimit   = 1000
	InitialReadyProbeLimit = 20

	defaultProbeBatchSize = 64
	dnsProbeHostLimit     = 3
)

// CoreProcess 抽象 mihomo 子进程句柄，便于单测注入替身。
type CoreProcess interface {
	PID() int
	SignalTerm() error
	Kill() error
	Wait() error
}

type execCoreProcess struct {
	cmd     *exec.Cmd
	pid     int
	done    chan struct{}
	waitErr error
}

func defaultSpawnCore(_ context.Context, binaryPath string, args []string) (CoreProcess, error) {
	cmd := exec.Command(binaryPath, args...)
	cmd.Stdin = nil
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	pid := 0
	if cmd.Process != nil {
		pid = cmd.Process.Pid
	}
	proc := &execCoreProcess{
		cmd:  cmd,
		pid:  pid,
		done: make(chan struct{}),
	}
	go func() {
		proc.waitErr = cmd.Wait()
		close(proc.done)
	}()
	return proc, nil
}

func (p *execCoreProcess) PID() int { return p.pid }

func (p *execCoreProcess) SignalTerm() error {
	if p.cmd == nil || p.cmd.Process == nil {
		return nil
	}
	return p.cmd.Process.Signal(syscall.SIGTERM)
}

func (p *execCoreProcess) Kill() error {
	if p.cmd == nil || p.cmd.Process == nil {
		return nil
	}
	return p.cmd.Process.Kill()
}

func (p *execCoreProcess) Wait() error {
	<-p.done
	return p.waitErr
}

// DNSProbeStatus 记录启动前内核 DNS 就绪自检结果。
type DNSProbeStatus struct {
	OK      bool   `json:"ok"`
	Host    string `json:"host,omitempty"`
	Address string `json:"address,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

// PoolStartResult 描述 StartPool 的执行结果。
type PoolStartResult struct {
	OK        bool   `json:"ok"`
	ProxyURL  string `json:"proxyUrl,omitempty"`
	NodeCount int    `json:"nodeCount,omitempty"`
	Error     string `json:"error,omitempty"`
}

// MaintenanceOptions 覆盖单轮维护的数量配额。
type MaintenanceOptions struct {
	GeoLimit   int
	ProbeLimit int
}

// MaintenanceResult 返回单轮后台维护完成的地理位置与上游实测更新数。
type MaintenanceResult struct {
	Geo    int    `json:"geo"`
	Probes int    `json:"probes"`
	Error  string `json:"error,omitempty"`
}

// ProbeDueOptions 控制到期节点探测的数量与模式。
type ProbeDueOptions struct {
	All   bool
	Limit int
}

type startCall struct {
	done   chan struct{}
	result PoolStartResult
}

type maintenanceCall struct {
	done   chan struct{}
	result MaintenanceResult
}

// PoolSupervisor 管理本机回环 mihomo 子进程启动、孤儿回收、DNS 自检与定期探测。
type PoolSupervisor struct {
	mgr                 *Manager
	aiHomeDir           string
	enabled             bool
	mixedPort           int
	controllerPort      int
	probePort           int
	lanePorts           []int
	startupTimeout      time.Duration
	startupPollInterval time.Duration
	switchSettleDelay   time.Duration
	reapTimeout         time.Duration
	startRetryBackoff   time.Duration
	probeInterval       time.Duration
	probeBatchSize      int
	probeConcurrency    int
	corePath            string
	interfacesFunc      func() ([]NetInterfaceEntry, error)
	spawnCore           func(ctx context.Context, binaryPath string, args []string) (CoreProcess, error)
	killPID             func(pid int) error
	pidAlive            func(pid int) bool
	ownerPID            int
	platform            string
	logger              func(string)

	rotMu sync.Mutex

	mu                sync.Mutex
	generation        uint64
	started           bool
	childAlive        bool
	proc              CoreProcess
	spawnedCorePID    int
	stateFileWritten  bool
	controllerSecret  string
	workDir           string
	lastError         string
	dnsProbe          *DNSProbeStatus
	nodeNames         []string
	activeNodeIndex   int
	startInFlight     *startCall
	lastFailedStartAt int64
	lastStartResult   *PoolStartResult
	probeLoopCancel   context.CancelFunc
	probeLoopWG       sync.WaitGroup
	ensureWG          sync.WaitGroup
}

func newPoolSupervisor(mgr *Manager, opts ManagerOptions) *PoolSupervisor {
	enabled := true
	if opts.Enabled != nil {
		enabled = *opts.Enabled
	}
	mixedPort := opts.MixedPort
	if mixedPort <= 0 {
		mixedPort = DefaultMixedPort
	}
	controllerPort := opts.ControllerPort
	if controllerPort <= 0 {
		controllerPort = DefaultControllerPort
	}
	probePort := opts.ProbePort
	if opts.DisableProbePort {
		probePort = 0
	} else if probePort <= 0 {
		probePort = DefaultProbePort
	}
	laneSlots := opts.LaneSlots
	if opts.DisableLanes {
		laneSlots = 0
	} else if laneSlots <= 0 {
		laneSlots = DefaultLaneSlots
	}
	laneBase := opts.LanePortBase
	if laneBase <= 0 {
		laneBase = DefaultLanePortBase
	}
	var lanePorts []int
	if laneSlots > 0 {
		lanePorts = make([]int, laneSlots)
		for i := 0; i < laneSlots; i++ {
			lanePorts[i] = laneBase + i
		}
	}

	startupTimeout := opts.StartupTimeout
	if startupTimeout <= 0 {
		startupTimeout = DefaultStartupTimeout
	}
	pollInterval := opts.StartupPollInterval
	if pollInterval <= 0 {
		pollInterval = DefaultStartupPollInterval
	}
	settle := opts.SwitchSettleDelay
	if opts.DisableSwitchSettle {
		settle = 0
	} else if settle <= 0 {
		settle = DefaultSwitchSettleDelay
	}
	reapTimeout := opts.ReapTimeout
	if reapTimeout <= 0 {
		reapTimeout = DefaultReapTimeout
	}
	retryBackoff := opts.StartRetryBackoff
	if retryBackoff == 0 {
		retryBackoff = DefaultStartRetryBackoff
	} else if retryBackoff < 0 {
		retryBackoff = 0
	}
	probeInterval := opts.ProbeInterval
	if opts.DisableProbeLoop {
		probeInterval = 0
	} else if probeInterval <= 0 {
		probeInterval = DefaultProbeIntervalMS * time.Millisecond
	}
	probeBatch := opts.ProbeBatchSize
	if probeBatch <= 0 {
		probeBatch = defaultProbeBatchSize
	}
	probeConcurrency := opts.ProbeConcurrency
	if probeConcurrency <= 0 {
		probeConcurrency = DefaultProbeConcurrency
	}
	spawnCore := opts.SpawnCore
	if spawnCore == nil {
		spawnCore = defaultSpawnCore
	}
	killPID := opts.KillPID
	if killPID == nil {
		killPID = func(pid int) error {
			if pid <= 0 {
				return nil
			}
			return syscall.Kill(pid, syscall.SIGTERM)
		}
	}
	ownerPID := opts.OwnerPID
	if ownerPID <= 0 {
		ownerPID = os.Getpid()
	}

	return &PoolSupervisor{
		mgr:                 mgr,
		aiHomeDir:           strings.TrimSpace(opts.AIHomeDir),
		enabled:             enabled,
		mixedPort:           mixedPort,
		controllerPort:      controllerPort,
		probePort:           probePort,
		lanePorts:           lanePorts,
		startupTimeout:      startupTimeout,
		startupPollInterval: pollInterval,
		switchSettleDelay:   settle,
		reapTimeout:         reapTimeout,
		startRetryBackoff:   retryBackoff,
		probeInterval:       probeInterval,
		probeBatchSize:      probeBatch,
		probeConcurrency:    probeConcurrency,
		corePath:            strings.TrimSpace(opts.CorePath),
		interfacesFunc:      opts.InterfacesFunc,
		spawnCore:           spawnCore,
		killPID:             killPID,
		ownerPID:            ownerPID,
		platform:            strings.TrimSpace(opts.Platform),
		logger:              mgr.logger,
	}
}

func (s *PoolSupervisor) isTrackedAlivePID(pid int) bool {
	if s == nil || pid <= 0 {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.childAlive && s.spawnedCorePID > 0 && pid == s.spawnedCorePID {
		return true
	}
	if (s.started || s.startInFlight != nil) && pid == s.ownerPID {
		return true
	}
	return false
}

// Ready 返回出口池子进程是否就绪。
func (s *PoolSupervisor) Ready() bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.started && s.childAlive
}

// IsStarting 返回当前是否有启动过程正在进行。
func (s *PoolSupervisor) IsStarting() bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.startInFlight != nil
}

// ProxyURL 返回出口池默认出站代理地址；未就绪返回空串。
func (s *PoolSupervisor) ProxyURL() string {
	if !s.Ready() {
		return ""
	}
	return fmt.Sprintf("http://%s:%d", PoolBindHost, s.mixedPort)
}

// LastError 返回最近一次启动或运行时错误码。
func (s *PoolSupervisor) LastError() string {
	if s == nil {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.lastError != "" {
		return s.lastError
	}
	if s.lastStartResult != nil && !s.lastStartResult.OK {
		return s.lastStartResult.Error
	}
	return ""
}

// Start 同步启动出口池（并发调用复用同一次启动结果）。
func (s *PoolSupervisor) Start(ctx context.Context) PoolStartResult {
	if s == nil || !s.enabled {
		return PoolStartResult{OK: false, Error: "egress_pool_disabled"}
	}
	if ctx == nil {
		ctx = context.Background()
	}

	s.mu.Lock()
	if s.started && s.childAlive {
		url := fmt.Sprintf("http://%s:%d", PoolBindHost, s.mixedPort)
		cnt := len(s.nodeNames)
		s.mu.Unlock()
		return PoolStartResult{OK: true, ProxyURL: url, NodeCount: cnt}
	}
	if s.startInFlight != nil {
		call := s.startInFlight
		s.mu.Unlock()
		select {
		case <-call.done:
			return call.result
		case <-ctx.Done():
			return PoolStartResult{OK: false, Error: "egress_pool_start_canceled"}
		}
	}
	call := &startCall{done: make(chan struct{})}
	s.startInFlight = call
	s.mu.Unlock()

	result := s.startOnce(ctx)

	s.mu.Lock()
	if result.OK {
		s.lastFailedStartAt = 0
	} else {
		s.lastFailedStartAt = s.mgr.nowMS()
	}
	copied := result
	s.lastStartResult = &copied
	if s.startInFlight == call {
		s.startInFlight = nil
	}
	call.result = result
	close(call.done)
	s.mu.Unlock()

	return result
}

// EnsureStarted 在满足条件时异步触发一次后台启动（未就绪、未启动中、冷却已过），不阻塞调用方。
func (s *PoolSupervisor) EnsureStarted(ctx context.Context) bool {
	if s == nil || !s.enabled {
		return false
	}
	nowMS := s.mgr.nowMS()
	s.mu.Lock()
	if (s.started && s.childAlive) || s.startInFlight != nil {
		s.mu.Unlock()
		return false
	}
	if s.lastFailedStartAt > 0 && s.startRetryBackoff > 0 && nowMS-s.lastFailedStartAt < s.startRetryBackoff.Milliseconds() {
		s.mu.Unlock()
		return false
	}
	s.ensureWG.Add(1)
	s.mu.Unlock()

	runCtx := context.Background()
	if ctx != nil && ctx.Err() == nil {
		// 不跟随单次 HTTP 请求取消，避免首请求结束后中途杀掉冷启动。
	}
	go func() {
		defer s.ensureWG.Done()
		_ = s.Start(runCtx)
	}()
	return true
}

func (s *PoolSupervisor) currentGen() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.generation
}

func (s *PoolSupervisor) setErrorResult(errCode string) PoolStartResult {
	s.mu.Lock()
	s.lastError = errCode
	s.mu.Unlock()
	return PoolStartResult{OK: false, Error: errCode}
}

func (s *PoolSupervisor) startOnce(ctx context.Context) PoolStartResult {
	nodes, err := ReadProxyPoolNodes(s.aiHomeDir)
	if err != nil {
		return s.setErrorResult(err.Error())
	}

	var corePath string
	if s.corePath != "" {
		if !isValidCoreFile(os.Stat, s.corePath) {
			return s.setErrorResult("egress_pool_core_not_found")
		}
		corePath = s.corePath
	} else {
		coreRes, err := ResolveMihomoCorePath(CoreResolverOptions{
			AIHomeDir: s.aiHomeDir,
			Platform:  s.platform,
		})
		if err != nil || coreRes == nil {
			return s.setErrorResult("egress_pool_core_not_found")
		}
		corePath = coreRes.Path
	}

	gen := s.currentGen()
	stoppedMeanwhile := func() bool {
		return ctx.Err() != nil || s.currentGen() != gen
	}

	s.reapOwnOrphan(ctx)
	if stoppedMeanwhile() {
		return s.setErrorResult("egress_pool_stopped_during_start")
	}

	if ControllerPortAnswers(ctx, s.controllerPort, s.mgr.httpClient) {
		return s.setErrorResult("egress_pool_controller_port_in_use")
	}
	if stoppedMeanwhile() {
		return s.setErrorResult("egress_pool_stopped_during_start")
	}

	secretBuf := make([]byte, 24)
	if _, err := rand.Read(secretBuf); err != nil {
		return s.setErrorResult("egress_pool_secret_failed")
	}
	secret := hex.EncodeToString(secretBuf)

	built, err := BuildEgressPoolConfig(PoolConfigInput{
		Nodes:          nodes,
		MixedPort:      s.mixedPort,
		ControllerPort: s.controllerPort,
		Secret:         secret,
		InterfacesFunc: s.interfacesFunc,
		ProbePort:      s.probePort,
		LanePorts:      s.lanePorts,
	})
	if err != nil {
		return s.setErrorResult("egress_pool_config_failed:" + err.Error())
	}

	workDir := filepath.Join(s.aiHomeDir, "run", "egress-pool")
	if err := os.MkdirAll(workDir, 0o700); err != nil {
		return s.setErrorResult("egress_pool_workdir_failed:" + err.Error())
	}
	_ = os.Chmod(workDir, 0o700)
	configPath := filepath.Join(workDir, "config.json")
	if err := os.WriteFile(configPath, built.JSONBytes, 0o600); err != nil {
		return s.setErrorResult("egress_pool_workdir_failed:" + err.Error())
	}
	_ = os.Chmod(configPath, 0o600)

	proc, err := s.spawnCore(ctx, corePath, []string{"-d", workDir, "-f", configPath})
	if err != nil || proc == nil {
		errMsg := "nil_process"
		if err != nil {
			errMsg = err.Error()
		}
		return s.setErrorResult("egress_pool_spawn_failed:" + errMsg)
	}

	corePID := proc.PID()
	s.mu.Lock()
	if s.generation != gen {
		s.mu.Unlock()
		terminateCoreProcess(proc)
		return s.setErrorResult("egress_pool_stopped_during_start")
	}
	s.workDir = workDir
	s.controllerSecret = secret
	s.proc = proc
	s.spawnedCorePID = corePID
	s.childAlive = true
	s.lastError = ""
	s.mu.Unlock()

	exitedCh := make(chan struct{})
	go func() {
		_ = proc.Wait()
		close(exitedCh)
		s.mu.Lock()
		if s.proc == proc {
			s.childAlive = false
			s.started = false
			wasWritten := s.stateFileWritten
			s.stateFileWritten = false
			s.mu.Unlock()
			if wasWritten {
				_ = RemovePoolStateFile(s.aiHomeDir)
			}
			return
		}
		s.mu.Unlock()
	}()

	ctrl := NewControllerClient(s.controllerPort, secret, s.mgr.httpClient)
	if readyErr := s.waitForReady(ctx, ctrl, gen, exitedCh); readyErr != "" {
		s.Stop()
		return s.setErrorResult(readyErr)
	}
	if stoppedMeanwhile() {
		s.Stop()
		return s.setErrorResult("egress_pool_stopped_during_start")
	}

	dnsProbe := verifyNodeResolvable(ctx, ctrl, nodes)
	s.mu.Lock()
	s.dnsProbe = &dnsProbe
	s.mu.Unlock()
	if !dnsProbe.OK {
		reason := dnsProbe.Reason
		if reason == "" {
			reason = "egress_pool_dns_unresolved"
		}
		s.logger(fmt.Sprintf("egress-pool dns check failed: %s (host=%s)", reason, dnsProbe.Host))
		s.Stop()
		return s.setErrorResult(reason)
	}

	proxyURL := fmt.Sprintf("http://%s:%d", PoolBindHost, s.mixedPort)
	s.mgr.health.BindNamedEntries(built.NodeEntries)

	activeIndex := 0
	if len(built.NodeNames) > 0 && s.mgr.health.IsCooling(built.NodeNames[0], s.mgr.nowMS()) {
		policy := ReadNodePolicy(ctx, s.aiHomeDir)
		if picked := s.mgr.health.PickNext(-1, nil, nil, &policy, s.mgr.nowMS()); picked > 0 && picked < len(built.NodeNames) {
			if err := ctrl.SelectProxy(ctx, mihomoGlobalGroup, built.NodeNames[picked]); err == nil {
				s.mgr.health.RecordSwitch(built.NodeNames[0], built.NodeNames[picked], "select")
				activeIndex = picked
			}
		}
	}

	initialState := &PoolStateFile{
		Version:        stateFileVersion,
		OwnerPID:       s.ownerPID,
		CorePID:        corePID,
		ProxyURL:       proxyURL,
		ControllerPort: s.controllerPort,
		Secret:         secret,
		StartedAt:      s.mgr.nowMS(),
		Lanes:          map[string]string{},
		SessionLanes:   map[string][]string{},
	}
	stateWritten := false
	if stateBytes, err := json.MarshalIndent(initialState, "", "  "); err == nil {
		if writeErr := writeStateFileAtomic(s.aiHomeDir, append(stateBytes, '\n')); writeErr == nil {
			stateWritten = true
		}
	}

	s.mu.Lock()
	if s.generation != gen || !s.childAlive {
		s.mu.Unlock()
		s.Stop()
		return s.setErrorResult("egress_pool_stopped_during_start")
	}
	s.started = true
	s.stateFileWritten = stateWritten
	s.nodeNames = append([]string(nil), built.NodeNames...)
	s.activeNodeIndex = activeIndex
	s.mu.Unlock()

	s.startProbeLoop()
	_ = s.mgr.ReconcileLanes(ctx)
	s.mgr.triggerInitialMaintenance()

	s.logger(fmt.Sprintf("egress-pool ready: %d nodes on %s", len(built.NodeNames), proxyURL))
	return PoolStartResult{
		OK:        true,
		ProxyURL:  proxyURL,
		NodeCount: len(built.NodeNames),
	}
}

func (s *PoolSupervisor) waitForReady(ctx context.Context, ctrl *ControllerClient, gen uint64, exitedCh <-chan struct{}) string {
	deadline := time.Now().Add(s.startupTimeout)
	for {
		if ctx.Err() != nil || s.currentGen() != gen {
			return "egress_pool_stopped_during_start"
		}
		select {
		case <-exitedCh:
			return "egress_pool_core_exited"
		default:
		}
		reqCtx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
		ok, err := ctrl.Version(reqCtx)
		cancel()
		if err == nil && ok {
			select {
			case <-exitedCh:
				return "egress_pool_core_exited"
			default:
				return ""
			}
		}
		if time.Now().After(deadline) {
			return "egress_pool_startup_timeout"
		}
		timer := time.NewTimer(s.startupPollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return "egress_pool_stopped_during_start"
		case <-exitedCh:
			timer.Stop()
			return "egress_pool_core_exited"
		case <-timer.C:
		}
	}
}

func verifyNodeResolvable(ctx context.Context, ctrl *ControllerClient, nodes []ProxyNode) DNSProbeStatus {
	var hosts []string
	seen := make(map[string]struct{}, dnsProbeHostLimit)
	for _, entry := range nodes {
		server := strings.TrimSpace(entry.Server)
		if server == "" || IsIPLiteral(server) {
			continue
		}
		if _, dup := seen[server]; dup {
			continue
		}
		seen[server] = struct{}{}
		hosts = append(hosts, server)
		if len(hosts) >= dnsProbeHostLimit {
			break
		}
	}
	if len(hosts) == 0 {
		return DNSProbeStatus{OK: true}
	}
	for _, host := range hosts {
		addr, err := ctrl.DNSQuery(ctx, host, "A")
		if err != nil || addr == "" {
			continue
		}
		if IsTUNAddress(addr) {
			return DNSProbeStatus{
				OK:      false,
				Host:    host,
				Address: addr,
				Reason:  "egress_pool_dns_fake_ip",
			}
		}
		return DNSProbeStatus{
			OK:      true,
			Host:    host,
			Address: addr,
		}
	}
	return DNSProbeStatus{
		OK:     false,
		Host:   hosts[0],
		Reason: "egress_pool_dns_unresolved",
	}
}

func (s *PoolSupervisor) reapOwnOrphan(ctx context.Context) string {
	state, err := ReadPoolStateFile(s.aiHomeDir)
	if err != nil || state == nil {
		return ""
	}
	if state.OwnerPID != s.ownerPID && s.pidAlive(state.OwnerPID) {
		return ""
	}
	if !s.pidAlive(state.CorePID) {
		_ = RemovePoolStateFile(s.aiHomeDir)
		return ""
	}
	if state.Secret == "" || state.ControllerPort <= 0 {
		return ""
	}
	ctrl := NewControllerClient(state.ControllerPort, state.Secret, s.mgr.httpClient)
	reqCtx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
	ok, err := ctrl.Version(reqCtx)
	cancel()
	if err != nil || !ok {
		return ""
	}
	if err := s.killPID(state.CorePID); err != nil {
		return ""
	}
	deadline := time.Now().Add(s.reapTimeout)
	for time.Now().Before(deadline) && s.pidAlive(state.CorePID) {
		timer := time.NewTimer(s.startupPollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ""
		case <-timer.C:
		}
	}
	_ = RemovePoolStateFile(s.aiHomeDir)
	s.logger(fmt.Sprintf("egress-pool reaped orphaned core pid %d", state.CorePID))
	return "reaped"
}

func (s *PoolSupervisor) startProbeLoop() {
	s.stopProbeLoop()
	if s.probeInterval <= 0 {
		return
	}
	loopCtx, cancel := context.WithCancel(context.Background())
	s.mu.Lock()
	s.probeLoopCancel = cancel
	s.probeLoopWG.Add(1)
	s.mu.Unlock()

	go func() {
		defer s.probeLoopWG.Done()
		ticker := time.NewTicker(s.probeInterval)
		defer ticker.Stop()
		for {
			select {
			case <-loopCtx.Done():
				return
			case <-ticker.C:
				_ = s.mgr.ProbeDueNodes(loopCtx, ProbeDueOptions{Limit: s.probeBatchSize})
			}
		}
	}()
}

func (s *PoolSupervisor) stopProbeLoop() {
	s.mu.Lock()
	cancel := s.probeLoopCancel
	s.probeLoopCancel = nil
	s.mu.Unlock()
	if cancel != nil {
		cancel()
		s.probeLoopWG.Wait()
	}
}

// Stop 停止 mihomo 子进程与探测协程并移除运行文件；幂等。
func (s *PoolSupervisor) Stop() {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.generation++
	wasStarted := s.started
	wasWritten := s.stateFileWritten
	proc := s.proc
	cancelProbe := s.probeLoopCancel
	s.probeLoopCancel = nil
	s.started = false
	s.childAlive = false
	s.stateFileWritten = false
	s.proc = nil
	s.spawnedCorePID = 0
	s.nodeNames = nil
	s.mu.Unlock()

	if cancelProbe != nil {
		cancelProbe()
	}
	s.probeLoopWG.Wait()

	if wasStarted && s.mgr != nil && s.mgr.health != nil {
		_ = s.mgr.health.Save()
	}
	if wasWritten {
		_ = RemovePoolStateFile(s.aiHomeDir)
	}
	if proc != nil {
		terminateCoreProcess(proc)
	}
}

func terminateCoreProcess(proc CoreProcess) {
	if proc == nil {
		return
	}
	_ = proc.SignalTerm()
	done := make(chan struct{})
	go func() {
		_ = proc.Wait()
		close(done)
	}()
	timer := time.NewTimer(1500 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
		_ = proc.Kill()
		<-done
	}
}

// Start 启动出口池后台守护与定期规划/维护循环（若已有 pool 绑定则在后台拉起内核）。
func (m *Manager) Start(ctx context.Context) error {
	if m == nil {
		return nil
	}
	m.daemonMu.Lock()
	if m.daemonActive {
		m.daemonMu.Unlock()
		return nil
	}
	baseCtx := ctx
	if baseCtx == nil {
		baseCtx = context.Background()
	}
	daemonCtx, cancel := context.WithCancel(baseCtx)
	m.daemonActive = true
	m.daemonCancel = cancel

	if m.supervisor != nil && m.supervisor.enabled && HasAnyEgressPoolBinding(daemonCtx, m.aiHomeDir) {
		m.daemonWG.Add(1)
		go func() {
			defer m.daemonWG.Done()
			res := m.supervisor.Start(daemonCtx)
			if !res.OK && m.logger != nil {
				m.logger("egress pool skipped: " + res.Error)
			}
		}()
	}

	if m.supervisor != nil && m.supervisor.enabled && m.planInterval > 0 {
		m.daemonWG.Add(1)
		go func() {
			defer m.daemonWG.Done()
			ticker := time.NewTicker(m.planInterval)
			defer ticker.Stop()
			for {
				select {
				case <-daemonCtx.Done():
					return
				case <-ticker.C:
					if !m.IsPoolReady() {
						continue
					}
					_ = m.ReconcileLanes(daemonCtx)
					_ = m.MaintenanceTick(daemonCtx, MaintenanceOptions{})
				}
			}
		}()
	}
	m.daemonMu.Unlock()
	return nil
}

// Close 停止出口池后台守护、定期维护循环及 mihomo 子进程（实现 io.Closer）。
func (m *Manager) Close() error {
	if m == nil {
		return nil
	}
	m.daemonMu.Lock()
	cancel := m.daemonCancel
	m.daemonCancel = nil
	m.daemonActive = false
	m.daemonMu.Unlock()

	if cancel != nil {
		cancel()
	}
	if m.supervisor != nil {
		m.supervisor.Stop()
		m.supervisor.ensureWG.Wait()
	}
	m.daemonWG.Wait()
	return nil
}

func (m *Manager) triggerInitialMaintenance() {
	m.daemonMu.Lock()
	active := m.daemonActive
	daemonCancel := m.daemonCancel
	m.daemonMu.Unlock()
	if !active || daemonCancel == nil {
		return
	}
	m.daemonWG.Add(1)
	go func() {
		defer m.daemonWG.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = m.MaintenanceTick(ctx, MaintenanceOptions{
			GeoLimit:   InitialReadyGeoLimit,
			ProbeLimit: InitialReadyProbeLimit,
		})
	}()
}

// IsPoolReady 判断本机出口池当前是否处于可用运行态。
func (m *Manager) IsPoolReady() bool {
	if m == nil {
		return false
	}
	if m.supervisor != nil && m.supervisor.Ready() {
		return true
	}
	state, _ := ReadLivePoolState(m.aiHomeDir, m.pidAlive)
	return state != nil
}

// StartPool 同步启动或复用出口池内核。
func (m *Manager) StartPool(ctx context.Context) PoolStartResult {
	if m == nil || m.supervisor == nil {
		return PoolStartResult{OK: false, Error: "egress_pool_unavailable"}
	}
	return m.supervisor.Start(ctx)
}

// EnsurePoolStarted 惰性异步触发出口池启动（遵守失败退避冷却），不阻塞当前调用。
func (m *Manager) EnsurePoolStarted(ctx context.Context) bool {
	if m == nil || m.supervisor == nil {
		return false
	}
	return m.supervisor.EnsureStarted(ctx)
}

// StopPool 停止当前托管的出口池内核。
func (m *Manager) StopPool() {
	if m != nil && m.supervisor != nil {
		m.supervisor.Stop()
	}
}

func (m *Manager) computeCurrentPlan(ctx context.Context) PlannedEgressResult {
	_ = m.syncHealthBindingsLocked()
	policy := ReadNodePolicy(ctx, m.aiHomeDir)
	snapshots, _ := m.health.Snapshot(&policy)
	blocked := make(map[string]bool, len(snapshots))
	for _, s := range snapshots {
		if s.Blocked {
			blocked[s.Name] = true
		}
	}
	cat, _ := ReadEgressPoolCatalog(m.aiHomeDir)
	pNodes := make([]PlannerNode, 0, len(snapshots))
	for _, s := range snapshots {
		groupSet := make(map[string]bool)
		for _, g := range cat.Groups {
			for _, id := range g.Identities {
				if id == s.Identity {
					groupSet[g.ID] = true
					break
				}
			}
		}
		pNodes = append(pNodes, PlannerNode{
			Name:     s.Name,
			NodeID:   s.NodeID,
			Identity: s.Identity,
			Label:    s.Label,
			Geo:      s.Geo,
			Groups:   groupSet,
		})
	}
	accounts, _ := ListKnownAccounts(ctx, m.aiHomeDir)
	bindings, _ := ReadAccountEgressBindings(ctx, m.aiHomeDir)
	assignments := m.assignments.ListAssignments(ctx)
	overrides := ReadServerUpstreamOverrides(ctx, m.aiHomeDir)
	laneSlots := DefaultLaneSlots
	if cfg, ok := ReadPoolRuntimeConfig(m.aiHomeDir); ok && cfg != nil && len(cfg.LanePorts) > 0 {
		laneSlots = len(cfg.LanePorts)
	}
	return ComputeEgressPlan(ctx, PlanInput{
		AIHomeDir:   m.aiHomeDir,
		Accounts:    accounts,
		Overrides:   overrides,
		Nodes:       pNodes,
		Catalog:     cat.Groups,
		Blocked:     blocked,
		LaneSlots:   laneSlots,
		Bindings:    bindings,
		Assignments: assignments,
		Evidence:    m.evidence,
		NowMS:       m.nowMS(),
	})
}

// ProbeDueNodes 探测一批到期（冷却中/被拦截/未探测过）的节点。
func (m *Manager) ProbeDueNodes(ctx context.Context, opts ProbeDueOptions) []NodeProbeOutcome {
	if !m.IsPoolReady() {
		return nil
	}
	m.probeJobMu.Lock()
	if m.backgroundProbe {
		m.probeJobMu.Unlock()
		return nil
	}
	m.backgroundProbe = true
	m.probeJobMu.Unlock()
	defer func() {
		m.probeJobMu.Lock()
		m.backgroundProbe = false
		m.probeJobMu.Unlock()
	}()

	_ = m.syncHealthBindingsLocked()
	policy := ReadNodePolicy(ctx, m.aiHomeDir)
	var names []string
	if opts.All {
		for _, n := range m.health.Nodes() {
			names = append(names, n.Name)
		}
	} else {
		limit := opts.Limit
		if limit <= 0 {
			limit = defaultProbeBatchSize
		}
		names = m.health.DueForProbe(limit, &policy, m.nowMS())
	}
	if len(names) == 0 {
		return nil
	}

	concurrency := 1
	if opts.All || len(names) > defaultProbeBatchSize {
		concurrency = DefaultProbeConcurrency
		if m.supervisor != nil && m.supervisor.probeConcurrency > 0 {
			concurrency = m.supervisor.probeConcurrency
		}
	}
	if concurrency > len(names) {
		concurrency = len(names)
	}

	results := make([]NodeProbeOutcome, len(names))
	jobs := make(chan int, len(names))
	for i := range names {
		jobs <- i
	}
	close(jobs)

	var wg sync.WaitGroup
	wg.Add(concurrency)
	for w := 0; w < concurrency; w++ {
		go func() {
			defer wg.Done()
			for idx := range jobs {
				if ctx.Err() != nil || !m.IsPoolReady() {
					return
				}
				results[idx] = m.ProbeNode(ctx, names[idx])
			}
		}()
	}
	wg.Wait()
	return results
}

// MaintenanceTick 执行一轮后台维护：优先补齐挂起车道的节点地理位置，再被动探测过期上游实测，并在变更后重排车道。
func (m *Manager) MaintenanceTick(ctx context.Context, opts MaintenanceOptions) MaintenanceResult {
	if m == nil {
		return MaintenanceResult{}
	}
	if ctx == nil {
		ctx = context.Background()
	}

	m.maintMu.Lock()
	if m.maintInFlight != nil {
		call := m.maintInFlight
		m.maintMu.Unlock()
		select {
		case <-call.done:
			return call.result
		case <-ctx.Done():
			return MaintenanceResult{}
		}
	}
	call := &maintenanceCall{done: make(chan struct{})}
	m.maintInFlight = call
	m.maintMu.Unlock()

	res := m.runMaintenanceTick(ctx, opts)

	m.maintMu.Lock()
	if m.maintInFlight == call {
		m.maintInFlight = nil
	}
	call.result = res
	close(call.done)
	m.maintMu.Unlock()
	return res
}

func (m *Manager) runMaintenanceTick(ctx context.Context, opts MaintenanceOptions) MaintenanceResult {
	if !m.IsPoolReady() {
		return MaintenanceResult{}
	}
	computed := m.computeCurrentPlan(ctx)
	if len(computed.Plan) == 0 {
		return MaintenanceResult{}
	}

	geoLimit := opts.GeoLimit
	if geoLimit <= 0 {
		geoLimit = m.geoPerTick
	}
	probeLimit := opts.ProbeLimit
	if probeLimit <= 0 {
		probeLimit = m.probesPerTick
	}

	geoCount := m.refreshMaintenanceGeos(ctx, computed, geoLimit)
	if ctx.Err() != nil {
		return MaintenanceResult{Geo: geoCount}
	}
	probeCount := m.refreshMaintenanceEvidence(ctx, m.computeCurrentPlan(ctx), probeLimit)
	if geoCount > 0 || probeCount > 0 {
		_ = m.ReconcileLanes(ctx)
	}
	return MaintenanceResult{Geo: geoCount, Probes: probeCount}
}

func (m *Manager) refreshMaintenanceGeos(ctx context.Context, computed PlannedEgressResult, limit int) int {
	if limit <= 0 {
		return 0
	}
	hasPending := false
	for _, acc := range computed.Accounts {
		if acc != nil && acc.Pending > 0 {
			hasPending = true
			break
		}
	}
	priority := make(map[string]bool)
	var ordered []string
	if hasPending {
		for _, node := range computed.Nodes {
			if node.Geo == nil || strings.TrimSpace(node.Geo.Country) == "" {
				priority[node.Name] = true
				ordered = append(ordered, node.Name)
			}
		}
	}
	for _, node := range computed.Nodes {
		if !priority[node.Name] {
			ordered = append(ordered, node.Name)
		}
	}

	atMS := m.nowMS()
	var due []string
	for _, name := range ordered {
		if len(due) >= limit {
			break
		}
		cached := m.health.GeoOf(name)
		if cached == nil || cached.At+m.nodeGeoTTLMS <= atMS {
			due = append(due, name)
		}
	}

	changed := 0
	for _, name := range due {
		if ctx.Err() != nil || !m.IsPoolReady() {
			break
		}
		loc, err := m.LookupNodeGeo(ctx, name, true)
		if err == nil && loc != nil && strings.TrimSpace(loc.Country) != "" {
			changed++
			if changed%ReconcileEveryGeoUpdates == 0 {
				_ = m.ReconcileLanes(ctx)
			}
		}
	}
	return changed
}

func (m *Manager) refreshMaintenanceEvidence(ctx context.Context, computed PlannedEgressResult, limit int) int {
	if limit <= 0 {
		return 0
	}
	byUpstream := make(map[string]map[string]bool)
	for _, lane := range computed.Plan {
		uid := strings.TrimSpace(lane.Upstream)
		if uid == "" || uid == "unknown" {
			continue
		}
		set := byUpstream[uid]
		if set == nil {
			set = make(map[string]bool)
			byUpstream[uid] = set
		}
		names := lane.ScopeNames
		if len(names) == 0 {
			names = lane.Allowed
		}
		for _, n := range names {
			if strings.TrimSpace(n) != "" {
				set[n] = true
			}
		}
	}
	if len(byUpstream) == 0 {
		return 0
	}

	upstreamIDs := make([]string, 0, len(byUpstream))
	for uid := range byUpstream {
		upstreamIDs = append(upstreamIDs, uid)
	}
	sort.Strings(upstreamIDs)

	probed := 0
	atMS := m.nowMS()
	for _, uid := range upstreamIDs {
		if probed >= limit || ctx.Err() != nil {
			break
		}
		upInfo := computed.Upstreams[uid]
		if upInfo == nil {
			continue
		}
		upCtx := ReadUpstreamDecisionContext(ctx, m.aiHomeDir, upInfo)
		if upCtx == nil {
			continue
		}
		ttl := upCtx.TTLMS
		if ttl <= 0 {
			ttl = DefaultEvidenceTTLMS
		}
		evidenceMap := ReadUpstreamEvidence(ctx, m.aiHomeDir, uid)

		nodeNames := make([]string, 0, len(byUpstream[uid]))
		for n := range byUpstream[uid] {
			nodeNames = append(nodeNames, n)
		}
		sort.Strings(nodeNames)

		for _, name := range nodeNames {
			if probed >= limit || ctx.Err() != nil || !m.IsPoolReady() {
				break
			}
			exitKey := NodeExitKey(m.health.IdentityOf(name))
			if exitKey != "" {
				if entry, exists := evidenceMap[exitKey]; exists && entry.At+ttl > atMS {
					continue
				}
			}
			_ = m.ProbeUpstreamViaNode(ctx, upInfo, name)
			probed++
		}
	}
	return probed
}

// RotatePoolNode 在 GLOBAL 策略组上切到下一个未冷却/未拦截节点（fromNode 非当前活动节点时不前进）。
func (m *Manager) RotatePoolNode(ctx context.Context, fromNode string, reason string) string {
	if !m.IsPoolReady() {
		return ""
	}
	if m.supervisor != nil {
		m.supervisor.rotMu.Lock()
		defer m.supervisor.rotMu.Unlock()
	}
	state, _ := ReadLivePoolState(m.aiHomeDir, m.pidAlive)
	if state == nil || state.ControllerPort <= 0 || state.Secret == "" {
		return ""
	}
	_ = m.syncHealthBindingsLocked()
	nodes := m.health.Nodes()
	if len(nodes) == 0 {
		return ""
	}
	ctrl := NewControllerClient(state.ControllerPort, state.Secret, m.httpClient)
	proxies, err := ctrl.GetProxies(ctx)
	if err != nil {
		return ""
	}
	active := strings.TrimSpace(proxies[mihomoGlobalGroup].Now)
	expected := strings.TrimSpace(fromNode)
	if expected != "" && active != "" && expected != active {
		return active
	}
	activeIdx := -1
	for i, n := range nodes {
		if n.Name == active {
			activeIdx = i
			break
		}
	}
	policy := ReadNodePolicy(ctx, m.aiHomeDir)
	picked := m.health.PickNext(activeIdx, nil, nil, &policy, m.nowMS())
	if picked < 0 {
		picked = (activeIdx + 1) % len(nodes)
	}
	nextName := nodes[picked].Name
	if err := ctrl.SelectProxy(ctx, mihomoGlobalGroup, nextName); err != nil {
		return ""
	}
	if reason == "" {
		reason = "rotate"
	}
	m.health.RecordSwitch(active, nextName, reason)
	if m.supervisor != nil && m.supervisor.switchSettleDelay > 0 {
		select {
		case <-ctx.Done():
		case <-time.After(m.supervisor.switchSettleDelay):
		}
	}
	return nextName
}

// RotateAccountLane 为指定账号的车道切换下一个节点；无专属车道时回落到 GLOBAL 轮换。
func (m *Manager) RotateAccountLane(ctx context.Context, accountRef string, fromNode string, reason string) string {
	ref := strings.TrimSpace(accountRef)
	if ref == "" {
		return m.RotatePoolNode(ctx, fromNode, reason)
	}
	computed := m.computeCurrentPlan(ctx)
	laneIdx := -1
	var matchedSpec LanePlanSpec
	for idx, spec := range computed.Plan {
		for _, a := range spec.Accounts {
			if a == ref {
				if spec.SessionSlot <= 0 {
					laneIdx = idx
					matchedSpec = spec
					break
				}
			}
		}
		if laneIdx >= 0 {
			break
		}
	}
	if laneIdx < 0 {
		return m.RotatePoolNode(ctx, fromNode, reason)
	}

	if m.supervisor != nil {
		m.supervisor.rotMu.Lock()
		defer m.supervisor.rotMu.Unlock()
	}
	state, _ := ReadLivePoolState(m.aiHomeDir, m.pidAlive)
	if state == nil || state.ControllerPort <= 0 || state.Secret == "" {
		return ""
	}
	ctrl := NewControllerClient(state.ControllerPort, state.Secret, m.httpClient)
	proxies, err := ctrl.GetProxies(ctx)
	if err != nil {
		return ""
	}
	groupName := LaneGroupName(laneIdx)
	active := strings.TrimSpace(proxies[groupName].Now)
	expected := strings.TrimSpace(fromNode)
	if expected != "" && active != "" && expected != active {
		return active
	}

	nodes := m.health.Nodes()
	if len(nodes) == 0 {
		return ""
	}
	fromIdx := -1
	for i, n := range nodes {
		if n.Name == active {
			fromIdx = i
			break
		}
	}
	allowedSet := make(map[string]bool, len(matchedSpec.Allowed))
	for _, n := range matchedSpec.Allowed {
		allowedSet[n] = true
	}
	avoidSet := make(map[string]bool)
	if matchedSpec.AvoidGroup != "" {
		for idx, spec := range computed.Plan {
			if idx != laneIdx && spec.AvoidGroup == matchedSpec.AvoidGroup {
				if otherNow := strings.TrimSpace(proxies[LaneGroupName(idx)].Now); otherNow != "" {
					avoidSet[otherNow] = true
				}
			}
		}
	}
	policy := ReadNodePolicy(ctx, m.aiHomeDir)
	picked := m.health.PickNext(fromIdx, allowedSet, avoidSet, &policy, m.nowMS())
	if picked < 0 || picked >= len(nodes) {
		return ""
	}
	nextName := nodes[picked].Name
	if err := ctrl.SelectProxy(ctx, groupName, nextName); err != nil {
		return ""
	}
	if reason == "" {
		reason = "rotate"
	}
	if active != nextName {
		m.health.RecordSwitch(active, nextName, fmt.Sprintf("%s@lane-%d", reason, laneIdx))
	}
	if m.supervisor != nil && m.supervisor.switchSettleDelay > 0 {
		select {
		case <-ctx.Done():
		case <-time.After(m.supervisor.switchSettleDelay):
		}
	}
	return nextName
}

// CurrentAccountPoolNode 返回指定账号当前车道（或全局组）的节点名。
func (m *Manager) CurrentAccountPoolNode(ctx context.Context, accountRef string) string {
	state, _ := ReadLivePoolState(m.aiHomeDir, m.pidAlive)
	if state == nil || state.ControllerPort <= 0 || state.Secret == "" {
		return ""
	}
	ctrl := NewControllerClient(state.ControllerPort, state.Secret, m.httpClient)
	proxies, err := ctrl.GetProxies(ctx)
	if err != nil {
		return ""
	}
	ref := strings.TrimSpace(accountRef)
	if ref != "" {
		computed := m.computeCurrentPlan(ctx)
		for idx, spec := range computed.Plan {
			if spec.SessionSlot > 0 {
				continue
			}
			for _, a := range spec.Accounts {
				if a == ref {
					return strings.TrimSpace(proxies[LaneGroupName(idx)].Now)
				}
			}
		}
	}
	return strings.TrimSpace(proxies[mihomoGlobalGroup].Now)
}

// CurrentAccountProxyURL 返回账号当前应使用的本地出口池回环地址（blocked/overflow/未就绪返回空串，绝不回落）。
func (m *Manager) CurrentAccountProxyURL(ctx context.Context, accountRef string, session bool) string {
	state, _ := ReadLivePoolState(m.aiHomeDir, m.pidAlive)
	if state == nil {
		return ""
	}
	ref := strings.TrimSpace(accountRef)
	if ref != "" {
		if session && len(state.SessionLanes[ref]) > 0 {
			pid := os.Getpid()
			if m.ownerPID > 0 {
				pid = m.ownerPID
			}
			if alloc := AcquireSessionLane(m.aiHomeDir, ref, state.SessionLanes[ref], pid, m.pidAlive, m.nowMS()); alloc != nil && alloc.URL != "" {
				return alloc.URL
			}
		}
		if laneURL, exists := state.Lanes[ref]; exists {
			// state.Lanes 显式记为空串时表示车道无可用节点/被拦截，必须 fail-closed。
			return strings.TrimSpace(laneURL)
		}
		computed := m.computeCurrentPlan(ctx)
		if info := computed.Accounts[ref]; info != nil {
			if info.BlockedReason != "" || info.Allowed == 0 {
				return ""
			}
			return ""
		}
	}
	return strings.TrimSpace(state.ProxyURL)
}

// DescribePoolUnavailable 返回出口池或账号车道不可用时的诊断原因。
func (m *Manager) DescribePoolUnavailable(ctx context.Context, accountRef string) string {
	state, liveErr := ReadLivePoolState(m.aiHomeDir, m.pidAlive)
	if state == nil {
		if m.supervisor != nil {
			if supErr := m.supervisor.LastError(); supErr != "" {
				return supErr
			}
			if m.supervisor.IsStarting() {
				return "egress_pool_starting"
			}
		}
		if liveErr != "" {
			return liveErr
		}
		return "egress_pool_not_ready"
	}
	ref := strings.TrimSpace(accountRef)
	if ref != "" {
		computed := m.computeCurrentPlan(ctx)
		if info := computed.Accounts[ref]; info != nil {
			if info.BlockedReason != "" {
				return info.BlockedReason
			}
			laneSlots := DefaultLaneSlots
			if cfg, ok := ReadPoolRuntimeConfig(m.aiHomeDir); ok && cfg != nil && len(cfg.LanePorts) > 0 {
				laneSlots = len(cfg.LanePorts)
			}
			for idx, spec := range computed.Plan {
				for _, a := range spec.Accounts {
					if a == ref && idx >= laneSlots {
						return "egress_pool_lane_overflow"
					}
				}
			}
			if _, exists := state.Lanes[ref]; !exists || state.Lanes[ref] == "" {
				return "egress_pool_lane_not_ready"
			}
		}
	}
	return "egress_pool_not_ready"
}

// RecordNodeOutcome 记录一次经出口请求结果；失败时写入冷却并对受影响策略组/车道轮换节点。
func (m *Manager) RecordNodeOutcome(ctx context.Context, nodeName string, ok bool, failureKind string, accountRef string, model string, retryAfterMS int64) {
	node := strings.TrimSpace(nodeName)
	if node == "" || m == nil || m.health == nil {
		return
	}
	if ok {
		m.health.RecordSuccess(node, accountRef)
		return
	}
	if m.health.RecordFailure(node, failureKind, accountRef, model, retryAfterMS) <= 0 {
		return
	}
	_ = m.RotatePoolNode(ctx, node, failureKind)
	computed := m.computeCurrentPlan(ctx)
	for _, spec := range computed.Plan {
		for _, ref := range spec.Accounts {
			if m.CurrentAccountPoolNode(ctx, ref) == node {
				_ = m.RotateAccountLane(ctx, ref, node, failureKind)
			}
		}
	}
}
