package egress

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// EgressProcess 是诊断视图里的一个相关进程。
type EgressProcess struct {
	PID     int    `json:"pid"`
	Command string `json:"command"`
	Kind    string `json:"kind"`
}

// EgressPortOwner 是出口池端口当前的监听者。
type EgressPortOwner struct {
	Port    int    `json:"port"`
	PID     int    `json:"pid"`
	Command string `json:"command"`
	AIH     bool   `json:"aih"`
}

// EgressPoolDiagnostics 汇总出口池运行文件与进程身份。
type EgressPoolDiagnostics struct {
	Running        bool   `json:"running"`
	MixedPort      int    `json:"mixedPort"`
	ControllerPort int    `json:"controllerPort"`
	ProbePort      int    `json:"probePort"`
	LanePorts      []int  `json:"lanePorts"`
	OwnerPID       int    `json:"ownerPid"`
	CorePID        int    `json:"corePid"`
	CoreKind       string `json:"coreKind,omitempty"`
	CoreVersion    string `json:"coreVersion,omitempty"`
	CoreSource     string `json:"coreSource"`
	CoreVerified   bool   `json:"coreVerified"`
	CoreCommand    string `json:"coreCommand"`
}

// EgressDiagnostics 是“代理层冲突检测”的只读诊断视图。
//
// 只观察端口与进程，不杀进程、不改系统网络；UI 用它证明 AIH 是否与
// Clash Verge / 其他代理内核发生端口或进程身份冲突。
type EgressDiagnostics struct {
	OK         bool                  `json:"ok"`
	Platform   string                `json:"platform"`
	Pool       EgressPoolDiagnostics `json:"pool"`
	Processes  []EgressProcess       `json:"processes"`
	PortOwners []EgressPortOwner     `json:"portOwners"`
	Conflicts  []string              `json:"conflicts"`
	Notes      []string              `json:"notes"`
}

// Diagnostics 生成出口池与外部代理内核的冲突诊断（只读）。
func (m *Manager) Diagnostics(ctx context.Context) EgressDiagnostics {
	out := EgressDiagnostics{
		OK:         true,
		Platform:   runtime.GOOS,
		Processes:  []EgressProcess{},
		PortOwners: []EgressPortOwner{},
		Conflicts:  []string{},
		Notes:      []string{},
	}
	if m == nil {
		out.OK = false
		out.Conflicts = append(out.Conflicts, "manager_unavailable")
		return out
	}
	out.Pool = m.poolDiagnostics(ctx)

	ports := make([]int, 0, 3+len(out.Pool.LanePorts))
	for _, port := range []int{out.Pool.MixedPort, out.Pool.ControllerPort, out.Pool.ProbePort} {
		if port > 0 {
			ports = append(ports, port)
		}
	}
	ports = append(ports, out.Pool.LanePorts...)
	seenPort := map[int]bool{}
	for _, port := range ports {
		if port <= 0 || seenPort[port] {
			continue
		}
		seenPort[port] = true
		out.PortOwners = append(out.PortOwners, portOwners(ctx, port)...)
	}

	out.Processes = relevantProxyProcesses(ctx)
	external := make([]string, 0)
	for _, process := range out.Processes {
		if process.Kind == "aih-core" {
			continue
		}
		external = append(external, fmt.Sprintf("%s(pid %d)", process.Kind, process.PID))
	}
	for _, owner := range out.PortOwners {
		if !owner.AIH {
			out.Conflicts = append(out.Conflicts, fmt.Sprintf("端口 %d 被 %s(pid %d) 占用", owner.Port, owner.Command, owner.PID))
		}
	}
	if out.Pool.CorePID > 0 && !out.Pool.CoreVerified {
		out.Conflicts = append(out.Conflicts, fmt.Sprintf(
			"池状态指向的 pid %d 不是 AIH 出口池内核（%s）",
			out.Pool.CorePID, trimCommand(out.Pool.CoreCommand),
		))
	}
	if !out.Pool.Running {
		out.Notes = append(out.Notes, "AIH 出口池未运行")
	}
	if len(external) > 0 {
		out.Notes = append(out.Notes, "检测到外部代理内核："+strings.Join(external, "、")+"；AIH 使用独立回环端口，不会接管或结束这些进程")
	}
	if out.Pool.CoreSource == "client" {
		out.Notes = append(out.Notes, "当前出口池使用桌面代理客户端自带内核；建议改用 ~/.ai_home/tools/mihomo 或 SSH 出口，避免与客户端实例互相干扰")
	}
	if len(ports) > 0 && len(out.PortOwners) == 0 {
		out.Notes = append(out.Notes, "出口池端口当前没有监听者（空闲或缺少 lsof）")
	}
	return out
}

func (m *Manager) poolDiagnostics(ctx context.Context) EgressPoolDiagnostics {
	var pool EgressPoolDiagnostics
	pool.LanePorts = []int{}
	if cfg, ok := ReadPoolRuntimeConfig(m.aiHomeDir); ok && cfg != nil {
		pool.MixedPort = cfg.MixedPort
		pool.ControllerPort = cfg.ControllerPort
		pool.ProbePort = cfg.ProbePort
		for _, port := range cfg.LanePorts {
			if port > 0 {
				pool.LanePorts = append(pool.LanePorts, port)
			}
		}
		sort.Ints(pool.LanePorts)
	}
	state, _ := ReadLivePoolState(m.aiHomeDir, m.pidAlive)
	if state == nil {
		return pool
	}
	pool.Running = true
	pool.OwnerPID = state.OwnerPID
	pool.CorePID = state.CorePID
	pool.CoreKind = state.CoreKind
	pool.CoreVersion = state.CoreVersion
	if pool.ControllerPort == 0 {
		pool.ControllerPort = state.ControllerPort
	}
	pool.CoreCommand = processCommand(ctx, state.CorePID)
	pool.CoreSource = classifyCoreSource(pool.CoreCommand)
	pool.CoreVerified = looksLikeAIHPoolCore(pool.CoreCommand)
	return pool
}

// classifyCoreSource 从命令行推断内核来源；只用于诊断展示。
func classifyCoreSource(command string) string {
	lower := strings.ToLower(strings.TrimSpace(command))
	switch {
	case lower == "":
		return ""
	case strings.Contains(lower, "/.ai_home/tools/") || strings.Contains(lower, "/.ai_home/bin/") ||
		strings.Contains(lower, "\\ai_home\\tools\\") || strings.Contains(lower, "\\ai_home\\bin\\"):
		return "managed"
	case strings.Contains(lower, "/applications/") || strings.Contains(lower, "program files"):
		return "client"
	default:
		return "path"
	}
}

func looksLikeAIHPoolCore(command string) bool {
	lower := strings.ToLower(strings.TrimSpace(command))
	if lower == "" || !strings.Contains(lower, "egress-pool") {
		return false
	}
	return strings.Contains(lower, "mihomo") || strings.Contains(lower, "clash") || strings.Contains(lower, "verge-mihomo") || strings.Contains(lower, "sing-box") || strings.Contains(lower, "singbox")
}

type coreIdentityEntry struct {
	at time.Time
	ok bool
}

var coreIdentityCache sync.Map

// coreIdentityVerifiable 表示当前平台能读进程命令行；Windows 暂不验证。
func coreIdentityVerifiable() bool {
	return runtime.GOOS != "windows"
}

// looksLikeAIHPoolCoreCached 缓存进程身份判定，避免每次读取池状态都跑 ps。
// PID 被复用给 Clash Verge 等外部内核时，缓存过期后会识别出来并拒绝复用。
func looksLikeAIHPoolCoreCached(pid int) bool {
	if pid <= 0 || !coreIdentityVerifiable() {
		return true
	}
	if cached, ok := coreIdentityCache.Load(pid); ok {
		entry := cached.(coreIdentityEntry)
		if time.Since(entry.at) < 10*time.Second {
			return entry.ok
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	verified := looksLikeAIHPoolCore(processCommand(ctx, pid))
	coreIdentityCache.Store(pid, coreIdentityEntry{at: time.Now(), ok: verified})
	return verified
}

func trimCommand(command string) string {
	text := strings.TrimSpace(command)
	if len(text) <= 160 {
		return text
	}
	return text[:160] + "…"
}

// processCommand 读取 pid 的带参数命令行；失败返回空串。
func processCommand(ctx context.Context, pid int) string {
	if pid <= 0 || runtime.GOOS == "windows" {
		return ""
	}
	cmdCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cmdCtx, "ps", "-o", "command=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// listProcesses 解析 `ps -axo pid=,command=`；不支持/失败返回空。
func listProcesses(ctx context.Context) []EgressProcess {
	if runtime.GOOS == "windows" {
		return nil
	}
	cmdCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cmdCtx, "ps", "-axo", "pid=,command=").Output()
	if err != nil {
		return nil
	}
	processes := make([]EgressProcess, 0, 128)
	for _, line := range strings.Split(string(out), "\n") {
		trimmed := strings.TrimSpace(line)
		index := strings.IndexAny(trimmed, " \t")
		if index <= 0 {
			continue
		}
		pid, parseErr := strconv.Atoi(strings.TrimSpace(trimmed[:index]))
		if parseErr != nil || pid <= 0 {
			continue
		}
		processes = append(processes, EgressProcess{PID: pid, Command: strings.TrimSpace(trimmed[index:])})
	}
	return processes
}

func relevantProxyProcesses(ctx context.Context) []EgressProcess {
	processes := listProcesses(ctx)
	filtered := make([]EgressProcess, 0, len(processes))
	for _, process := range processes {
		kind := classifyProxyProcess(process.Command)
		if kind == "" {
			continue
		}
		process.Kind = kind
		filtered = append(filtered, process)
	}
	sort.SliceStable(filtered, func(i, j int) bool { return filtered[i].PID < filtered[j].PID })
	return filtered
}

func classifyProxyProcess(command string) string {
	lower := strings.ToLower(strings.TrimSpace(command))
	switch {
	case strings.Contains(lower, "egress-pool") && (strings.Contains(lower, "mihomo") || strings.Contains(lower, "clash") || strings.Contains(lower, "sing-box") || strings.Contains(lower, "singbox")):
		return "aih-core"
	case strings.Contains(lower, "clash verge") || strings.Contains(lower, "clash-verge") || strings.Contains(lower, "verge-mihomo"):
		return "clash-verge"
	case strings.Contains(lower, "mihomo") || strings.Contains(lower, "clash-meta"):
		return "mihomo"
	case strings.Contains(lower, "sing-box") || strings.Contains(lower, "singbox"):
		return "sing-box"
	default:
		return ""
	}
}

// portOwners 读取端口监听者；优先 lsof（macOS/Linux），失败返回空。
func portOwners(ctx context.Context, port int) []EgressPortOwner {
	if port <= 0 || runtime.GOOS == "windows" {
		return nil
	}
	cmdCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cmdCtx, "lsof", "-nP", "-iTCP:"+strconv.Itoa(port), "-sTCP:LISTEN", "-Fpc").Output()
	if err != nil {
		return nil
	}
	owners := make([]EgressPortOwner, 0, 1)
	currentPID := 0
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		switch line[0] {
		case 'p':
			currentPID, _ = strconv.Atoi(line[1:])
		case 'c':
			owners = append(owners, EgressPortOwner{
				Port:    port,
				PID:     currentPID,
				Command: line[1:],
				AIH:     looksLikeAIHPoolCore(processCommand(ctx, currentPID)),
			})
		}
	}
	return owners
}
