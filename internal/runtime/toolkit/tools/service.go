package tools

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

const (
	brewStatusCacheTTL      = 3 * time.Second
	brewStatusMaxStale      = 10 * time.Minute
	maxServiceLogLines      = 400
	defaultServiceLogLines  = 200
	maxServiceLogReadBytes  = 256 * 1024
	supervisorStopGrace     = 5 * time.Second
	supervisorStableUptime  = 60 * time.Second
	supervisorPollInterval  = 3 * time.Second
)

var (
	defaultBackoffMs = []time.Duration{
		1 * time.Second, 2 * time.Second, 5 * time.Second,
		10 * time.Second, 30 * time.Second, 60 * time.Second,
	}
	ansiEscapeRx = regexp.MustCompile(`\x1b\[[0-9;]*m`)
)

// LaunchSpec 描述 AIH 守护进程的启动参数。
type LaunchSpec struct {
	Command string   `json:"command"`
	Args    []string `json:"args"`
	Cwd     string   `json:"cwd,omitempty"`
}

// LastExitInfo 记录守护进程最近一次退出的详情。
type LastExitInfo struct {
	Code     *int   `json:"code"`
	Signal   string `json:"signal"`
	Reason   string `json:"reason"`
	At       int64  `json:"at"`
	UptimeMs int64  `json:"uptimeMs"`
}

// ServiceStatus 对齐 Node describeToolService 的完整服务状态视图。
type ServiceStatus struct {
	Backend             string        `json:"backend"`
	BackendLabel        string        `json:"backendLabel,omitempty"`
	Controllable        bool          `json:"controllable"`
	State               string        `json:"state"`
	PID                 int           `json:"pid,omitempty"`
	ExitCode            *int          `json:"exitCode,omitempty"`
	StartedAt           int64         `json:"startedAt,omitempty"`
	Restarts            int           `json:"restarts,omitempty"`
	ConsecutiveFailures int           `json:"consecutiveFailures,omitempty"`
	NextRestartAt       int64         `json:"nextRestartAt,omitempty"`
	LastExit            *LastExitInfo `json:"lastExit,omitempty"`
	LastError           string        `json:"lastError,omitempty"`
	AutoStart           bool          `json:"autoStart"`
	AutoRestart         bool          `json:"autoRestart"`
	SettingsEditable    bool          `json:"settingsEditable"`
	SettingsNote        string        `json:"settingsNote,omitempty"`
	ConfigReady         bool          `json:"configReady,omitempty"`
	CanCreateConfig     bool          `json:"canCreateConfig,omitempty"`
	LogAvailable        bool          `json:"logAvailable"`
	Message             string        `json:"message,omitempty"`
	CanStart            bool          `json:"canStart"`
	CanStop             bool          `json:"canStop"`
	CanRestart          bool          `json:"canRestart"`
}

// ServiceOpResult 表示服务控制/配置/设置操作结果。
type ServiceOpResult struct {
	OK             bool           `json:"ok"`
	ToolID         string         `json:"toolId,omitempty"`
	Error          string         `json:"error,omitempty"`
	Message        string         `json:"message,omitempty"`
	Output         string         `json:"output,omitempty"`
	PID            int            `json:"pid,omitempty"`
	AlreadyRunning bool           `json:"alreadyRunning,omitempty"`
	ConfigName     string         `json:"configName,omitempty"`
	Service        *ServiceStatus `json:"service,omitempty"`
}

// ServiceLogsResult 表示服务日志读取结果。
type ServiceLogsResult struct {
	OK      bool     `json:"ok"`
	ToolID  string   `json:"toolId,omitempty"`
	Backend string   `json:"backend,omitempty"`
	Lines   []string `json:"lines,omitempty"`
	Error   string   `json:"error,omitempty"`
	Message string   `json:"message,omitempty"`
}

type persistedServiceState struct {
	Desired        string      `json:"desired"`
	AutoStart      bool        `json:"autoStart"`
	AutoRestart    bool        `json:"autoRestart"`
	ConfigPath     string      `json:"configPath"`
	ExecutablePath string      `json:"executablePath"`
	PID            int         `json:"pid"`
	StartedAt      int64       `json:"startedAt"`
	Launch         *LaunchSpec `json:"launch,omitempty"`
}

type serviceStateStore struct {
	mu        sync.Mutex
	directory string
	statePath string
}

func newServiceStateStore(aiHomeDir string, serviceID string) *serviceStateStore {
	dir := filepath.Join(aiHomeDir, "toolkit", "services")
	return &serviceStateStore{
		directory: dir,
		statePath: filepath.Join(dir, serviceID+".json"),
	}
}

func (s *serviceStateStore) read() persistedServiceState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readLocked()
}

func (s *serviceStateStore) readLocked() persistedServiceState {
	def := persistedServiceState{
		Desired:     "stopped",
		AutoStart:   true,
		AutoRestart: true,
	}
	raw, err := os.ReadFile(s.statePath)
	if err != nil {
		return def
	}
	_ = json.Unmarshal(raw, &def)
	if def.Desired == "" {
		def.Desired = "stopped"
	}
	return def
}

func (s *serviceStateStore) writePatch(update func(*persistedServiceState)) persistedServiceState {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur := s.readLocked()
	update(&cur)
	_ = os.MkdirAll(s.directory, 0o755)
	encoded, _ := json.MarshalIndent(cur, "", "  ")
	encoded = append(encoded, '\n')
	tmp := s.statePath + ".tmp-" + randHex(4)
	if err := os.WriteFile(tmp, encoded, 0o600); err == nil {
		if err := os.Rename(tmp, s.statePath); err != nil {
			_ = os.WriteFile(s.statePath, encoded, 0o600)
			_ = os.Remove(tmp)
		}
	}
	return cur
}

type brewCacheEntry struct {
	At   time.Time
	Info *brewServiceInfo
}

type brewServiceInfo struct {
	Running      bool   `json:"running"`
	PID          int    `json:"pid"`
	ExitCode     *int   `json:"exit_code"`
	Registered   bool   `json:"registered"`
	Loaded       bool   `json:"loaded"`
	LogPath      string `json:"log_path"`
	ErrorLogPath string `json:"error_log_path"`
}

// SpawnedProcess 抽象已启动子进程（用于测试或真实 detached 子进程）。
type SpawnedProcess struct {
	PID  int
	Wait func() (*int, string)
}

// SupervisorHooks 允许测试注入进程生命周期操作。
type SupervisorHooks struct {
	Spawn   func(spec LaunchSpec, logFile string) (SpawnedProcess, error)
	IsAlive func(pid int) bool
	IsOwned func(pid int, configPath string) bool
	Kill    func(pid int, sig string) bool
	Backoff []time.Duration
}

type detachedSupervisor struct {
	mu                  sync.Mutex
	store               *serviceStateStore
	logFile             string
	spec                toolServiceDef
	serviceID           string
	opts                Options
	hooks               SupervisorHooks
	phase               string
	pid                 int
	startedAt           int64
	restarts            int
	consecutiveFailures int
	nextRestartAt       int64
	lastExit            *LastExitInfo
	lastError           string
	restartTimer        *time.Timer
	pollStop            chan struct{}
}

func newDetachedSupervisor(aiHomeDir string, serviceID string, spec toolServiceDef, opts Options, hooks SupervisorHooks) *detachedSupervisor {
	logDir := strings.TrimSpace(opts.AIHLogDir)
	if logDir == "" {
		logDir = filepath.Join(aiHomeDir, "logs")
	}
	return &detachedSupervisor{
		store:     newServiceStateStore(aiHomeDir, serviceID),
		logFile:   filepath.Join(logDir, "toolkit-"+serviceID+".log"),
		spec:      spec,
		serviceID: serviceID,
		opts:      opts,
		hooks:     hooks,
		phase:     "stopped",
	}
}

func (sup *detachedSupervisor) isAlive(pid int) bool {
	if sup.hooks.IsAlive != nil {
		return sup.hooks.IsAlive(pid)
	}
	return defaultProcessAlive(pid)
}

func (sup *detachedSupervisor) isOwned(ctx context.Context, pid int, cfgPath string) bool {
	if sup.hooks.IsOwned != nil {
		return sup.hooks.IsOwned(pid, cfgPath)
	}
	if !sup.isAlive(pid) {
		return false
	}
	platform := sup.opts.nodePlatform()
	for _, entry := range ReadProcessEntries(ctx, sup.opts, []string{sup.spec.ProcessRole}) {
		if entry.PID != pid {
			continue
		}
		if !EntryDirectlyRunsRole(platform, entry, sup.spec.ProcessRole) {
			return false
		}
		if cfgPath == "" {
			return true
		}
		return sameToolPath(ExtractConfigPath(entry, sup.spec.ProcessRole, sup.opts), cfgPath, platform)
	}
	return false
}

func (sup *detachedSupervisor) killProc(pid int, sig string) bool {
	if sup.hooks.Kill != nil {
		return sup.hooks.Kill(pid, sig)
	}
	return defaultProcessKill(pid, sig)
}

func (sup *detachedSupervisor) backoffList() []time.Duration {
	if len(sup.hooks.Backoff) > 0 {
		return sup.hooks.Backoff
	}
	return defaultBackoffMs
}

func (sup *detachedSupervisor) cancelRestartLocked() {
	if sup.restartTimer != nil {
		sup.restartTimer.Stop()
		sup.restartTimer = nil
	}
	sup.nextRestartAt = 0
}

func (sup *detachedSupervisor) ensurePollingLocked() {
	if sup.pollStop != nil {
		return
	}
	stopCh := make(chan struct{})
	sup.pollStop = stopCh
	go func() {
		ticker := time.NewTicker(supervisorPollInterval)
		defer ticker.Stop()
		for {
			select {
			case <-stopCh:
				return
			case <-ticker.C:
				sup.mu.Lock()
				pid := sup.pid
				if pid > 0 && !sup.isAlive(pid) {
					sup.handleExitLocked(pid, nil, "", "process-gone")
				}
				sup.mu.Unlock()
			}
		}
	}()
}

func (sup *detachedSupervisor) stopPollingLocked() {
	if sup.pollStop != nil {
		close(sup.pollStop)
		sup.pollStop = nil
	}
}

func (sup *detachedSupervisor) launchLocked(spec LaunchSpec) (int, error) {
	if strings.TrimSpace(spec.Command) == "" {
		return 0, fmt.Errorf("缺少启动命令。")
	}
	var spawned SpawnedProcess
	var err error
	if sup.hooks.Spawn != nil {
		spawned, err = sup.hooks.Spawn(spec, sup.logFile)
	} else {
		spawned, err = spawnDetachedOSProcess(spec, sup.logFile)
	}
	if err != nil {
		sup.lastError = err.Error()
		return 0, err
	}
	if spawned.PID <= 0 {
		sup.lastError = "进程未能启动"
		return 0, fmt.Errorf("进程未能启动")
	}
	sup.phase = "running"
	sup.pid = spawned.PID
	sup.startedAt = sup.opts.Now().UnixMilli()
	sup.lastError = ""
	launchCopy := spec
	sup.store.writePatch(func(st *persistedServiceState) {
		st.PID = spawned.PID
		st.StartedAt = sup.startedAt
		st.Launch = &launchCopy
	})
	sup.ensurePollingLocked()
	if spawned.Wait != nil {
		pid := spawned.PID
		waitFn := spawned.Wait
		go func() {
			code, sig := waitFn()
			sup.mu.Lock()
			sup.handleExitLocked(pid, code, sig, "exit")
			sup.mu.Unlock()
		}()
	}
	return spawned.PID, nil
}

func spawnDetachedOSProcess(spec LaunchSpec, logFile string) (SpawnedProcess, error) {
	var logFD *os.File
	if logFile != "" {
		if err := os.MkdirAll(filepath.Dir(logFile), 0o755); err != nil {
			return SpawnedProcess{}, err
		}
		var err error
		logFD, err = os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			return SpawnedProcess{}, err
		}
	}
	cmd := exec.Command(spec.Command, spec.Args...)
	if spec.Cwd != "" {
		cmd.Dir = spec.Cwd
	}
	configureDetachedCmd(cmd)
	if logFD != nil {
		cmd.Stdout = logFD
		cmd.Stderr = logFD
	}
	err := cmd.Start()
	if logFD != nil {
		_ = logFD.Close()
	}
	if err != nil {
		return SpawnedProcess{}, err
	}
	return SpawnedProcess{
		PID: cmd.Process.Pid,
		Wait: func() (*int, string) {
			werr := cmd.Wait()
			return processExitStatus(cmd, werr)
		},
	}, nil
}

func (sup *detachedSupervisor) handleExitLocked(pid int, code *int, sig string, reason string) {
	if pid <= 0 || pid != sup.pid {
		return
	}
	nowMs := sup.opts.Now().UnixMilli()
	var uptime int64
	if sup.startedAt > 0 {
		uptime = nowMs - sup.startedAt
	}
	sup.lastExit = &LastExitInfo{
		Code:     code,
		Signal:   sig,
		Reason:   reason,
		At:       nowMs,
		UptimeMs: uptime,
	}
	sup.pid = 0
	sup.startedAt = 0
	sup.store.writePatch(func(st *persistedServiceState) {
		st.PID = 0
		st.StartedAt = 0
	})
	st := sup.store.read()
	if st.Desired == "running" && st.AutoRestart {
		if uptime >= supervisorStableUptime.Milliseconds() {
			sup.consecutiveFailures = 0
		} else {
			sup.consecutiveFailures++
		}
		sup.scheduleRestartLocked()
		return
	}
	sup.phase = "stopped"
	sup.stopPollingLocked()
}

func (sup *detachedSupervisor) scheduleRestartLocked() {
	list := sup.backoffList()
	idx := sup.consecutiveFailures
	if idx < 0 {
		idx = 0
	}
	if idx >= len(list) {
		idx = len(list) - 1
	}
	delay := list[idx]
	sup.phase = "backoff"
	sup.nextRestartAt = sup.opts.Now().UnixMilli() + delay.Milliseconds()
	sup.restartTimer = time.AfterFunc(delay, func() {
		sup.mu.Lock()
		defer sup.mu.Unlock()
		sup.restartTimer = nil
		sup.nextRestartAt = 0
		st := sup.store.read()
		if st.Desired != "running" || st.Launch == nil {
			return
		}
		sup.restarts++
		if _, err := sup.launchLocked(*st.Launch); err != nil {
			sup.consecutiveFailures++
			sup.scheduleRestartLocked()
		}
	})
}

func (sup *detachedSupervisor) start(spec LaunchSpec) ServiceOpResult {
	sup.mu.Lock()
	defer sup.mu.Unlock()
	sup.cancelRestartLocked()
	if sup.pid > 0 && sup.isAlive(sup.pid) {
		return ServiceOpResult{OK: true, PID: sup.pid, AlreadyRunning: true}
	}
	sup.store.writePatch(func(st *persistedServiceState) {
		st.Desired = "running"
	})
	sup.consecutiveFailures = 0
	pid, err := sup.launchLocked(spec)
	if err != nil {
		code := "service_spawn_failed"
		if strings.TrimSpace(spec.Command) == "" {
			code = "service_launch_spec_missing"
		}
		return ServiceOpResult{OK: false, Error: code, Message: err.Error()}
	}
	return ServiceOpResult{OK: true, PID: pid}
}

func (sup *detachedSupervisor) stop(ctx context.Context) ServiceOpResult {
	sup.mu.Lock()
	sup.store.writePatch(func(st *persistedServiceState) {
		st.Desired = "stopped"
	})
	sup.cancelRestartLocked()
	st := sup.store.read()
	pid := sup.pid
	if pid == 0 {
		pid = st.PID
	}
	owned := pid > 0 && sup.isOwned(ctx, pid, st.ConfigPath)
	sup.mu.Unlock()

	if owned {
		sup.killProc(pid, "SIGTERM")
		deadline := time.Now().Add(supervisorStopGrace)
		for time.Now().Before(deadline) && sup.isAlive(pid) {
			time.Sleep(100 * time.Millisecond)
		}
		if sup.isAlive(pid) {
			sup.killProc(pid, "SIGKILL")
		}
	}

	sup.mu.Lock()
	sup.phase = "stopped"
	sup.pid = 0
	sup.startedAt = 0
	sup.store.writePatch(func(st *persistedServiceState) {
		st.PID = 0
		st.StartedAt = 0
	})
	sup.stopPollingLocked()
	sup.mu.Unlock()
	return ServiceOpResult{OK: true}
}

func (sup *detachedSupervisor) adopt(ctx context.Context) ServiceOpResult {
	sup.mu.Lock()
	defer sup.mu.Unlock()
	st := sup.store.read()
	if st.PID > 0 && sup.isOwned(ctx, st.PID, st.ConfigPath) {
		sup.phase = "running"
		sup.pid = st.PID
		if st.StartedAt > 0 {
			sup.startedAt = st.StartedAt
		} else {
			sup.startedAt = sup.opts.Now().UnixMilli()
		}
		sup.ensurePollingLocked()
		return ServiceOpResult{OK: true, PID: st.PID}
	}
	if st.PID > 0 {
		sup.store.writePatch(func(s *persistedServiceState) {
			s.PID = 0
			s.StartedAt = 0
		})
	}
	if st.Desired == "running" && st.AutoStart && st.Launch != nil {
		pid, err := sup.launchLocked(*st.Launch)
		if err != nil {
			return ServiceOpResult{OK: false, Error: "service_spawn_failed", Message: err.Error()}
		}
		return ServiceOpResult{OK: true, PID: pid}
	}
	return ServiceOpResult{OK: true}
}

func (sup *detachedSupervisor) status() (phase string, pid int, startedAt int64, restarts int, failures int, nextRestart int64, lastExit *LastExitInfo, lastError string, st persistedServiceState) {
	sup.mu.Lock()
	defer sup.mu.Unlock()
	st = sup.store.read()
	if sup.phase == "running" && sup.pid > 0 && !sup.isAlive(sup.pid) {
		sup.handleExitLocked(sup.pid, nil, "", "process-gone")
	}
	return sup.phase, sup.pid, sup.startedAt, sup.restarts, sup.consecutiveFailures, sup.nextRestartAt, sup.lastExit, sup.lastError, st
}

func (sup *detachedSupervisor) updateSettings(autoStart *bool, autoRestart *bool) {
	sup.mu.Lock()
	defer sup.mu.Unlock()
	sup.store.writePatch(func(st *persistedServiceState) {
		if autoStart != nil {
			st.AutoStart = *autoStart
		}
		if autoRestart != nil {
			st.AutoRestart = *autoRestart
		}
	})
	if autoRestart != nil && !*autoRestart && sup.phase == "backoff" {
		sup.cancelRestartLocked()
		sup.phase = "stopped"
	}
}

func (sup *detachedSupervisor) dispose() {
	sup.mu.Lock()
	defer sup.mu.Unlock()
	sup.cancelRestartLocked()
	sup.stopPollingLocked()
}

// ServiceManager 统筹受管工具的服务探测、启停、配置新建与日志读取。
type ServiceManager struct {
	mu          sync.Mutex
	opts        Options
	supervisors map[string]*detachedSupervisor
	brewCache   map[string]brewCacheEntry
	brewRefresh map[string]bool
	Hooks       SupervisorHooks
}

// NewServiceManager 创建服务管理器（建议按 aiHomeDir 复用单例以保持守护态）。
func NewServiceManager(opts Options) *ServiceManager {
	return &ServiceManager{
		opts:        opts.withDefaults(),
		supervisors: make(map[string]*detachedSupervisor),
		brewCache:   make(map[string]brewCacheEntry),
		brewRefresh: make(map[string]bool),
	}
}

// Dispose 停止所有后台巡检与重连计时器。
func (sm *ServiceManager) Dispose() {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	for _, s := range sm.supervisors {
		s.dispose()
	}
}

func (sm *ServiceManager) getSupervisor(id string, spec toolServiceDef, o Options) *detachedSupervisor {
	aiHome := strings.TrimSpace(o.AIHomeDir)
	key := aiHome + "\x00" + id
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if s, ok := sm.supervisors[key]; ok {
		return s
	}
	s := newDetachedSupervisor(aiHome, id, spec, o, sm.Hooks)
	sm.supervisors[key] = s
	return s
}

func (sm *ServiceManager) resolveTarget(ctx context.Context, toolID string) (toolPlugin, ToolView, string, *ServiceOpResult) {
	norm := strings.ToLower(strings.TrimSpace(toolID))
	plugin, ok := getToolPlugin(norm)
	if !ok || plugin.Service == nil {
		return toolPlugin{}, ToolView{}, "", &ServiceOpResult{
			OK:      false,
			Error:   "service_unsupported",
			Message: "该工具不提供服务管理。",
		}
	}
	o := sm.opts
	if o.ProcessEntriesOverride == nil {
		o.ProcessEntriesOverride = ReadProcessEntries(ctx, o, networkToolIDs)
	}
	rt := DiscoverNetworkTools(ctx, o)
	noSvc := false
	listOpts := o
	listOpts.IncludeService = &noSvc
	listRes := ListManagedTools(ctx, listOpts, nil)
	for _, t := range listRes.Tools {
		if t.ID == norm {
			return plugin, t, rt[norm].ConfigPath, nil
		}
	}
	return toolPlugin{}, ToolView{}, "", &ServiceOpResult{
		OK:      false,
		Error:   "managed_tool_not_found",
		Message: "工具不存在或不适用于当前系统。",
	}
}

func (sm *ServiceManager) useHomebrewBackend(plugin toolPlugin, tool ToolView, o Options) string {
	if tool.ManagedBy == "homebrew" && plugin.Service != nil && plugin.Service.HomebrewFormula != "" {
		return resolveBrewBinary(o)
	}
	return ""
}

func resolveBrewBinary(o Options) string {
	if o.FileExistsOverride != nil {
		for _, c := range brewCandidates {
			if o.FileExistsOverride(c) {
				return c
			}
		}
		return ""
	}
	for _, c := range brewCandidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return ""
}

func (sm *ServiceManager) readBrewInfo(ctx context.Context, brewPath string, formula string, o Options) *brewServiceInfo {
	key := brewPath + "\x00" + formula
	now := o.Now()
	sm.mu.Lock()
	cached, exists := sm.brewCache[key]
	if exists {
		age := now.Sub(cached.At)
		if age < brewStatusCacheTTL {
			sm.mu.Unlock()
			return cached.Info
		}
		if age < brewStatusMaxStale {
			if !sm.brewRefresh[key] {
				sm.brewRefresh[key] = true
				go sm.refreshBrewAsync(brewPath, formula, key, o)
			}
			sm.mu.Unlock()
			return cached.Info
		}
	}
	sm.mu.Unlock()

	res := o.Exec.Run(ctx, brewPath, []string{"services", "info", formula, "--json"}, environment.ExecOptions{
		Env:     map[string]string{"HOMEBREW_NO_AUTO_UPDATE": "1"},
		Timeout: 10 * time.Second,
	})
	var info *brewServiceInfo
	if res.OK {
		info = parseBrewServiceInfo(res.Stdout)
	}
	sm.mu.Lock()
	sm.brewCache[key] = brewCacheEntry{At: o.Now(), Info: info}
	sm.mu.Unlock()
	return info
}

func (sm *ServiceManager) refreshBrewAsync(brewPath string, formula string, key string, o Options) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	res := o.Exec.Run(ctx, brewPath, []string{"services", "info", formula, "--json"}, environment.ExecOptions{
		Env:     map[string]string{"HOMEBREW_NO_AUTO_UPDATE": "1"},
		Timeout: 10 * time.Second,
	})
	var info *brewServiceInfo
	if res.OK {
		info = parseBrewServiceInfo(res.Stdout)
	}
	sm.mu.Lock()
	defer sm.mu.Unlock()
	delete(sm.brewRefresh, key)
	if _, ok := sm.brewCache[key]; !ok {
		return
	}
	sm.brewCache[key] = brewCacheEntry{At: o.Now(), Info: info}
}

func parseBrewServiceInfo(stdout string) *brewServiceInfo {
	trimmed := strings.TrimSpace(stdout)
	if trimmed == "" {
		return nil
	}
	if strings.HasPrefix(trimmed, "[") {
		var list []brewServiceInfo
		if err := json.Unmarshal([]byte(trimmed), &list); err == nil && len(list) > 0 {
			return &list[0]
		}
		return nil
	}
	var single brewServiceInfo
	if err := json.Unmarshal([]byte(trimmed), &single); err == nil {
		return &single
	}
	return nil
}

func (sm *ServiceManager) describeWithRuntime(ctx context.Context, plugin toolPlugin, tool ToolView, resolvedCfg string, o Options) ServiceStatus {
	if plugin.Service == nil {
		return ServiceStatus{Backend: "none", State: "unknown"}
	}
	if brew := sm.useHomebrewBackend(plugin, tool, o); brew != "" {
		info := sm.readBrewInfo(ctx, brew, plugin.Service.HomebrewFormula, o)
		if info == nil {
			return ServiceStatus{
				Backend:      "homebrew",
				BackendLabel: "Homebrew 服务",
				Controllable: false,
				State:        "unknown",
				Message:      "无法读取 brew services 状态",
			}
		}
		state := "stopped"
		if info.Running {
			state = "running"
		} else if info.ExitCode != nil && *info.ExitCode != 0 {
			state = "error"
		}
		return ServiceStatus{
			Backend:          "homebrew",
			BackendLabel:     "Homebrew 服务",
			Controllable:     true,
			State:            state,
			PID:              info.PID,
			ExitCode:         info.ExitCode,
			AutoStart:        info.Registered || info.Loaded,
			AutoRestart:      true,
			SettingsEditable: false,
			SettingsNote:     "自动重启由 Homebrew 服务定义（KeepAlive）保证；开机自启随 brew services 注册状态变化",
			LogAvailable:     info.LogPath != "" || info.ErrorLogPath != "",
			CanStart:         !info.Running,
			CanStop:          info.Running || info.Registered,
			CanRestart:       info.Running,
		}
	}

	aiHome := strings.TrimSpace(o.AIHomeDir)
	if aiHome == "" {
		return ServiceStatus{
			Backend:      "aih",
			BackendLabel: "AIH 守护",
			Controllable: false,
			State:        "unknown",
			Message:      "缺少 AIH 数据目录",
		}
	}
	sup := sm.getSupervisor(plugin.ID, *plugin.Service, o)
	phase, pid, startedAt, restarts, failures, nextRestart, lastExit, lastErr, st := sup.status()
	cfgPath := resolveAihServiceConfigPath(st, *plugin.Service, resolvedCfg, o)
	cfgExists := envBoolExists(o, cfgPath)
	running := phase == "running"
	external := !running && tool.Running
	state := "stopped"
	if running {
		state = "running"
	} else if phase == "backoff" {
		state = "backoff"
	} else if external {
		state = "external"
	}
	msg := ""
	if external {
		msg = "检测到不受 AIH 守护的 frpc 进程（如 systemd / Windows 服务）正在运行，需先在原管理方式中停止"
	}
	return ServiceStatus{
		Backend:             "aih",
		BackendLabel:        "AIH 守护",
		Controllable:        tool.Installed,
		State:               state,
		PID:                 pid,
		StartedAt:           startedAt,
		Restarts:            restarts,
		ConsecutiveFailures: failures,
		NextRestartAt:       nextRestart,
		LastExit:            lastExit,
		LastError:           lastErr,
		AutoStart:           st.AutoStart,
		AutoRestart:         st.AutoRestart,
		SettingsEditable:    true,
		SettingsNote:        "进程独立于 AIH 运行；AIH 重启后接管或按「随 AIH 启动」恢复，异常退出按退避自动重启",
		ConfigReady:         cfgExists,
		CanCreateConfig:     !cfgExists,
		LogAvailable:        true,
		Message:             msg,
		CanStart:            tool.Installed && !running && !external && phase != "backoff" && cfgExists,
		CanStop:             running || phase == "backoff",
		CanRestart:          running,
	}
}

func resolveAihServiceConfigPath(st persistedServiceState, spec toolServiceDef, resolvedCfg string, o Options) string {
	if s := strings.TrimSpace(st.ConfigPath); s != "" {
		return s
	}
	if s := strings.TrimSpace(resolvedCfg); s != "" {
		return s
	}
	if spec.DefaultConfigPath != nil {
		return strings.TrimSpace(spec.DefaultConfigPath(o))
	}
	return ""
}

// DescribeToolService 返回工具的服务状态描述。
func (sm *ServiceManager) DescribeToolService(ctx context.Context, toolID string) ServiceOpResult {
	plugin, tool, resolvedCfg, errRes := sm.resolveTarget(ctx, toolID)
	if errRes != nil {
		return *errRes
	}
	svc := sm.describeWithRuntime(ctx, plugin, tool, resolvedCfg, sm.opts)
	return ServiceOpResult{OK: true, ToolID: tool.ID, Service: &svc}
}

// ControlToolService 执行服务 start / stop / restart。
func (sm *ServiceManager) ControlToolService(ctx context.Context, toolID string, action string) ServiceOpResult {
	normAction := strings.ToLower(strings.TrimSpace(action))
	if normAction != "start" && normAction != "stop" && normAction != "restart" {
		return ServiceOpResult{OK: false, Error: "unsupported_service_action", Message: "仅支持启动、停止和重启。"}
	}
	plugin, tool, resolvedCfg, errRes := sm.resolveTarget(ctx, toolID)
	if errRes != nil {
		return *errRes
	}
	o := sm.opts
	var res ServiceOpResult
	if brew := sm.useHomebrewBackend(plugin, tool, o); brew != "" {
		runRes := o.Exec.Run(ctx, brew, []string{"services", normAction, plugin.Service.HomebrewFormula}, environment.ExecOptions{
			Env:     map[string]string{"HOMEBREW_NO_AUTO_UPDATE": "1"},
			Timeout: 60 * time.Second,
		})
		key := brew + "\x00" + plugin.Service.HomebrewFormula
		sm.mu.Lock()
		delete(sm.brewCache, key)
		sm.mu.Unlock()
		if !runRes.OK {
			msg := firstNonEmpty(runRes.Stderr, runRes.Stdout, runRes.Message, "brew services "+normAction+" 失败")
			if len(msg) > 500 {
				msg = msg[:500]
			}
			res = ServiceOpResult{OK: false, Error: "service_control_failed", Message: msg}
		} else {
			out := runRes.Stdout
			if len(out) > 2000 {
				out = out[:2000]
			}
			res = ServiceOpResult{OK: true, Output: out}
		}
	} else {
		aiHome := strings.TrimSpace(o.AIHomeDir)
		if aiHome == "" {
			res = ServiceOpResult{OK: false, Error: "service_backend_unavailable", Message: "缺少 AIH 数据目录。"}
		} else {
			sup := sm.getSupervisor(plugin.ID, *plugin.Service, o)
			if normAction == "stop" {
				res = sup.stop(ctx)
			} else if !tool.Installed || tool.ExecutablePath == "" {
				res = ServiceOpResult{OK: false, Error: "managed_tool_not_installed", Message: plugin.Name + " 尚未安装。"}
			} else {
				st := sup.store.read()
				cfgPath := resolveAihServiceConfigPath(st, *plugin.Service, resolvedCfg, o)
				if !envBoolExists(o, cfgPath) {
					res = ServiceOpResult{OK: false, Error: "service_config_missing", Message: "配置文件不存在，请先新建并编辑配置。"}
				} else {
					_, ownPid, _, _, _, _, _, _, _ := sup.status()
					var conflict *ProcessEntry
					platform := o.nodePlatform()
					for _, entry := range ReadProcessEntries(ctx, o, []string{plugin.Service.ProcessRole}) {
						if !EntryDirectlyRunsRole(platform, entry, plugin.Service.ProcessRole) {
							continue
						}
						if ownPid > 0 && entry.PID == ownPid {
							continue
						}
						entryCfg := ExtractConfigPath(entry, plugin.Service.ProcessRole, o)
						if entryCfg == "" || sameToolPath(entryCfg, cfgPath, platform) {
							cp := entry
							conflict = &cp
							break
						}
					}
					if conflict != nil {
						res = ServiceOpResult{
							OK:      false,
							Error:   "service_conflict_external_instance",
							Message: fmt.Sprintf("已有 %s 进程（pid %d）在使用同一份配置，请先停止它再由 AIH 守护。", plugin.Name, conflict.PID),
						}
					} else {
						sup.store.writePatch(func(s *persistedServiceState) {
							s.ConfigPath = cfgPath
							s.ExecutablePath = tool.ExecutablePath
						})
						launch := LaunchSpec{
							Command: tool.ExecutablePath,
							Args:    plugin.Service.LaunchArgs(cfgPath),
							Cwd:     envPlatformDir(platform, cfgPath),
						}
						if normAction == "restart" {
							_ = sup.stop(ctx)
						}
						res = sup.start(launch)
					}
				}
			}
		}
	}
	res.ToolID = tool.ID
	svc := sm.describeWithRuntime(ctx, plugin, tool, resolvedCfg, o)
	res.Service = &svc
	return res
}

// UpdateToolServiceSettings 修改自启动与自动重启策略。
func (sm *ServiceManager) UpdateToolServiceSettings(ctx context.Context, toolID string, autoStart *bool, autoRestart *bool) ServiceOpResult {
	plugin, tool, resolvedCfg, errRes := sm.resolveTarget(ctx, toolID)
	if errRes != nil {
		return *errRes
	}
	o := sm.opts
	var res ServiceOpResult
	if sm.useHomebrewBackend(plugin, tool, o) != "" {
		res = ServiceOpResult{OK: false, Error: "service_settings_readonly", Message: "Homebrew 服务的自动重启与开机自启由 brew services 管理。"}
	} else if strings.TrimSpace(o.AIHomeDir) == "" {
		res = ServiceOpResult{OK: false, Error: "service_backend_unavailable", Message: "缺少 AIH 数据目录。"}
	} else {
		sup := sm.getSupervisor(plugin.ID, *plugin.Service, o)
		sup.updateSettings(autoStart, autoRestart)
		res = ServiceOpResult{OK: true}
	}
	res.ToolID = tool.ID
	svc := sm.describeWithRuntime(ctx, plugin, tool, resolvedCfg, o)
	res.Service = &svc
	return res
}

// CreateToolServiceConfig 为受管服务初始化默认配置文件。
func (sm *ServiceManager) CreateToolServiceConfig(ctx context.Context, toolID string) ServiceOpResult {
	plugin, tool, resolvedCfg, errRes := sm.resolveTarget(ctx, toolID)
	if errRes != nil {
		return *errRes
	}
	o := sm.opts
	if sm.useHomebrewBackend(plugin, tool, o) != "" {
		return ServiceOpResult{OK: false, ToolID: tool.ID, Error: "service_config_create_unsupported", Message: "当前服务后端不支持新建配置。"}
	}
	if strings.TrimSpace(o.AIHomeDir) == "" {
		return ServiceOpResult{OK: false, ToolID: tool.ID, Error: "service_backend_unavailable", Message: "缺少 AIH 数据目录。"}
	}
	sup := sm.getSupervisor(plugin.ID, *plugin.Service, o)
	st := sup.store.read()
	cfgPath := resolveAihServiceConfigPath(st, *plugin.Service, resolvedCfg, o)
	if cfgPath == "" {
		return ServiceOpResult{OK: false, ToolID: tool.ID, Error: "service_config_create_unsupported", Message: "无法确定配置路径。"}
	}
	if envBoolExists(o, cfgPath) {
		return ServiceOpResult{OK: false, ToolID: tool.ID, Error: "service_config_exists", Message: "配置文件已存在。"}
	}
	if err := os.MkdirAll(filepath.Dir(cfgPath), 0o755); err != nil {
		return ServiceOpResult{OK: false, ToolID: tool.ID, Error: "service_config_write_failed", Message: err.Error()}
	}
	f, err := os.OpenFile(cfgPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		if os.IsExist(err) {
			return ServiceOpResult{OK: false, ToolID: tool.ID, Error: "service_config_exists", Message: "配置文件已存在。"}
		}
		return ServiceOpResult{OK: false, ToolID: tool.ID, Error: "service_config_write_failed", Message: err.Error()}
	}
	_, writeErr := f.WriteString(plugin.Service.ConfigTemplate)
	_ = f.Close()
	if writeErr != nil {
		return ServiceOpResult{OK: false, ToolID: tool.ID, Error: "service_config_write_failed", Message: writeErr.Error()}
	}
	sup.store.writePatch(func(s *persistedServiceState) {
		s.ConfigPath = cfgPath
	})
	return ServiceOpResult{OK: true, ToolID: tool.ID, ConfigName: filepath.Base(cfgPath)}
}

// ReadToolServiceLogs 读取受管服务最近日志行。
func (sm *ServiceManager) ReadToolServiceLogs(ctx context.Context, toolID string, linesLimit int) ServiceLogsResult {
	plugin, tool, _, errRes := sm.resolveTarget(ctx, toolID)
	if errRes != nil {
		return ServiceLogsResult{OK: false, Error: errRes.Error, Message: errRes.Message}
	}
	o := sm.opts
	limit := linesLimit
	if limit <= 0 {
		limit = defaultServiceLogLines
	}
	if limit > maxServiceLogLines {
		limit = maxServiceLogLines
	}

	backendID := "aih"
	var files []string
	if brew := sm.useHomebrewBackend(plugin, tool, o); brew != "" {
		backendID = "homebrew"
		info := sm.readBrewInfo(ctx, brew, plugin.Service.HomebrewFormula, o)
		if info != nil {
			files = uniqueStrings([]string{info.LogPath, info.ErrorLogPath})
		}
	} else {
		sup := sm.getSupervisor(plugin.ID, *plugin.Service, o)
		if sup.logFile != "" {
			files = []string{sup.logFile}
		}
	}
	var allLines []string
	for _, f := range files {
		allLines = append(allLines, tailServiceLogFile(f, limit)...)
	}
	if len(allLines) > limit {
		allLines = allLines[len(allLines)-limit:]
	}
	if allLines == nil {
		allLines = []string{}
	}
	return ServiceLogsResult{OK: true, ToolID: tool.ID, Backend: backendID, Lines: allLines}
}

// RestoreToolServices 在服务启动时接管/恢复 AIH 守护的工具服务。
func (sm *ServiceManager) RestoreToolServices(ctx context.Context) []ServiceOpResult {
	o := sm.opts
	if strings.TrimSpace(o.AIHomeDir) == "" {
		return nil
	}
	var results []ServiceOpResult
	for _, plugin := range listToolPlugins(o.nodePlatform()) {
		if plugin.Service == nil {
			continue
		}
		sup := sm.getSupervisor(plugin.ID, *plugin.Service, o)
		res := sup.adopt(ctx)
		res.ToolID = plugin.ID
		results = append(results, res)
	}
	return results
}

func tailServiceLogFile(filePath string, limit int) []string {
	f, err := os.Open(filePath)
	if err != nil {
		return nil
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil
	}
	var start int64
	if info.Size() > maxServiceLogReadBytes {
		start = info.Size() - maxServiceLogReadBytes
	}
	if start > 0 {
		if _, err := f.Seek(start, 0); err != nil {
			return nil
		}
	}
	buf := make([]byte, info.Size()-start)
	n, err := f.Read(buf)
	if err != nil && n == 0 {
		return nil
	}
	rawLines := strings.Split(strings.ReplaceAll(string(buf[:n]), "\r\n", "\n"), "\n")
	if start > 0 && len(rawLines) > 0 {
		rawLines = rawLines[1:]
	}
	var out []string
	for _, l := range rawLines {
		cleaned := strings.TrimRight(ansiEscapeRx.ReplaceAllString(l, ""), " \t")
		if cleaned != "" {
			out = append(out, cleaned)
		}
	}
	if len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
