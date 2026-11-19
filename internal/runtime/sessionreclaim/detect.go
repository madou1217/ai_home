// Package sessionreclaim 只做"能不能回收"的判定，不做终止。
//
// 判定原则：只要有一项证据表明会话可能还在用，就保留。
// 未知（命令超时、解析失败、进程刚起）一律按保留处理，绝不猜测。
package sessionreclaim

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Session 是持久会话注册表里的一条记录。
type Session struct {
	Provider  string `json:"provider"`
	Socket    string `json:"socket"`
	Name      string `json:"session"`
	Cwd       string `json:"cwd"`
	UpdatedAt int64  `json:"updatedAt"`
	Path      string `json:"-"`
}

// Report 是单个会话的判定结果；Reasons 为空表示四项证据全部满足。
type Report struct {
	Provider         string   `json:"provider"`
	Session          string   `json:"session"`
	Socket           string   `json:"socket"`
	Cwd              string   `json:"cwd"`
	AttachedClients  int      `json:"attachedClients"`
	PanePID          int      `json:"panePid"`
	TreeProcesses    int      `json:"treeProcesses"`
	TreeRSSMB        int      `json:"treeRssMb"`
	CPUDeltaSeconds  float64  `json:"cpuDeltaSeconds"`
	EstablishedConns int      `json:"establishedConns"`
	IdleSeconds      int64    `json:"idleSeconds"`
	Eligible         bool     `json:"eligible"`
	Reasons          []string `json:"reasons"`
}

// Options 控制判定阈值；零值使用保守缺省。
type Options struct {
	// IdleThreshold 是"空闲多久才考虑回收"的宽限期。
	IdleThreshold time.Duration
	// CPUSample 是 CPU 时间增量的采样窗口。
	CPUSample time.Duration
	// CPUIdleFloor 是判定为"没有在干活"的 CPU 增量上限。
	CPUIdleFloor float64
	// Now 可注入，便于测试。
	Now func() time.Time
}

const defaultIdleThreshold = 4 * time.Hour

// Detect 扫描注册表并返回每个会话的判定结果（不执行任何终止）。
func Detect(ctx context.Context, aiHomeDir string, opts Options) ([]Report, error) {
	options := normalize(opts)
	dir := filepath.Join(aiHomeDir, "run", "persistent-sessions")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	sessions := make([]Session, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		raw, readErr := os.ReadFile(filepath.Clean(path))
		if readErr != nil {
			continue
		}
		var session Session
		if json.Unmarshal(raw, &session) != nil {
			continue
		}
		if session.Socket == "" || session.Name == "" {
			continue
		}
		session.Path = path
		sessions = append(sessions, session)
	}
	reports := make([]Report, 0, len(sessions))
	for _, session := range sessions {
		reports = append(reports, detectOne(ctx, session, options))
	}
	return reports, nil
}

func normalize(opts Options) Options {
	options := opts
	if options.IdleThreshold <= 0 {
		options.IdleThreshold = defaultIdleThreshold
	}
	if options.CPUSample <= 0 {
		options.CPUSample = 2 * time.Second
	}
	if options.CPUIdleFloor <= 0 {
		options.CPUIdleFloor = 0.05
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	return options
}

func detectOne(ctx context.Context, session Session, opts Options) Report {
	report := Report{
		Provider: session.Provider,
		Session:  session.Name,
		Socket:   session.Socket,
		Cwd:      session.Cwd,
		Reasons:  []string{},
	}
	if !tmuxSessionAlive(ctx, session.Socket, session.Name) {
		report.Reasons = append(report.Reasons, "session_not_running")
		return report
	}
	report.AttachedClients = tmuxAttachedClients(ctx, session.Socket, session.Name)
	if report.AttachedClients > 0 {
		report.Reasons = append(report.Reasons, "terminal_attached")
	}
	report.PanePID = tmuxPanePID(ctx, session.Socket, session.Name)
	if report.PanePID <= 0 {
		report.Reasons = append(report.Reasons, "pane_pid_unknown")
		return report
	}
	first, procs := processTree(ctx, report.PanePID)
	firstConns := establishedConns(ctx, procs)
	report.TreeProcesses = len(procs)
	report.TreeRSSMB = treeRSSMB(first)
	if len(procs) == 0 {
		report.Reasons = append(report.Reasons, "process_tree_unknown")
		return report
	}
	time.Sleep(opts.CPUSample)
	second, _ := processTree(ctx, report.PanePID)
	secondConns := establishedConns(ctx, procs)
	report.CPUDeltaSeconds = roundSeconds(totalCPUSeconds(second) - totalCPUSeconds(first))
	if report.CPUDeltaSeconds > opts.CPUIdleFloor {
		report.Reasons = append(report.Reasons, "cpu_active")
	}
	report.EstablishedConns = secondConns
	switch {
	case firstConns < 0 || secondConns < 0:
		// 拿不到连接信息时不作为放行依据：宁可保留。
		report.Reasons = append(report.Reasons, "connections_unknown")
	case secondConns > firstConns:
		// 采样窗口内新建连接 = 很可能正在请求模型；只看总量会把 keepalive 误判成活跃。
		report.Reasons = append(report.Reasons, "network_active")
	}
	report.IdleSeconds = int64(opts.Now().Sub(time.UnixMilli(session.UpdatedAt)).Seconds())
	if session.UpdatedAt <= 0 {
		report.Reasons = append(report.Reasons, "activity_unknown")
	} else if time.Duration(report.IdleSeconds)*time.Second < opts.IdleThreshold {
		report.Reasons = append(report.Reasons, "recent_activity")
	}
	report.Eligible = len(report.Reasons) == 0
	return report
}

func tmuxSessionAlive(ctx context.Context, socket, name string) bool {
	_, err := runShort(ctx, "tmux", "-L", socket, "has-session", "-t", name)
	return err == nil
}

func tmuxAttachedClients(ctx context.Context, socket, name string) int {
	out, err := runShort(ctx, "tmux", "-L", socket, "list-clients", "-t", name, "-F", "#{client_name}")
	if err != nil {
		return 0
	}
	count := 0
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if strings.TrimSpace(line) != "" {
			count++
		}
	}
	return count
}

func tmuxPanePID(ctx context.Context, socket, name string) int {
	out, err := runShort(ctx, "tmux", "-L", socket, "list-panes", "-t", name, "-F", "#{pane_pid}")
	if err != nil {
		return 0
	}
	value, convErr := strconv.Atoi(strings.TrimSpace(strings.Split(strings.TrimSpace(out), "\n")[0]))
	if convErr != nil {
		return 0
	}
	return value
}

type procInfo struct {
	pid   int
	ppid  int
	cpu   float64
	rssKB int
}

func processTree(ctx context.Context, rootPID int) (map[int]procInfo, []int) {
	out, err := runShort(ctx, "ps", "-Ao", "pid,ppid,time,rss")
	if err != nil {
		return nil, nil
	}
	children := map[int][]int{}
	byPID := map[int]procInfo{}
	for _, line := range strings.Split(out, "\n")[1:] {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		pid, pidErr := strconv.Atoi(fields[0])
		ppid, ppidErr := strconv.Atoi(fields[1])
		if pidErr != nil || ppidErr != nil {
			continue
		}
		rss, _ := strconv.Atoi(fields[3])
		info := procInfo{pid: pid, ppid: ppid, cpu: parseCPUTime(fields[2]), rssKB: rss}
		byPID[pid] = info
		children[ppid] = append(children[ppid], pid)
	}
	seen := map[int]bool{}
	order := []int{}
	stack := append([]int{}, children[rootPID]...)
	if _, ok := byPID[rootPID]; ok {
		stack = append([]int{rootPID}, stack...)
	}
	for len(stack) > 0 {
		pid := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[pid] {
			continue
		}
		seen[pid] = true
		order = append(order, pid)
		stack = append(stack, children[pid]...)
	}
	result := make(map[int]procInfo, len(order))
	for _, pid := range order {
		if info, ok := byPID[pid]; ok {
			result[pid] = info
		}
	}
	return result, order
}

func treeRSSMB(procs map[int]procInfo) int {
	total := 0
	for _, info := range procs {
		total += info.rssKB
	}
	return total / 1024
}

func totalCPUSeconds(procs map[int]procInfo) float64 {
	total := 0.0
	for _, info := range procs {
		total += info.cpu
	}
	return total
}

func establishedConns(ctx context.Context, procs []int) int {
	if len(procs) == 0 {
		return -1
	}
	pidArgs := make([]string, 0, len(procs)*2)
	for _, pid := range procs {
		pidArgs = append(pidArgs, "-p", strconv.Itoa(pid))
	}
	args := append([]string{"-nP"}, pidArgs...)
	args = append(args, "-iTCP", "-sTCP:ESTABLISHED")
	out, err := runShort(ctx, "lsof", args...)
	if err != nil {
		return -1
	}
	count := 0
	for _, line := range strings.Split(out, "\n")[1:] {
		if strings.Contains(line, "ESTABLISHED") {
			count++
		}
	}
	return count
}

// parseCPUTime 解析 ps 的 time 列：MM:SS.ss / HH:MM:SS / D-HH:MM:SS。
func parseCPUTime(value string) float64 {
	text := strings.TrimSpace(value)
	if text == "" {
		return 0
	}
	days := 0
	if index := strings.Index(text, "-"); index > 0 {
		days, _ = strconv.Atoi(text[:index])
		text = text[index+1:]
	}
	parts := strings.Split(text, ":")
	if len(parts) == 0 {
		return 0
	}
	seconds := 0.0
	for _, part := range parts {
		number, _ := strconv.ParseFloat(part, 64)
		seconds = seconds*60 + number
	}
	return seconds + float64(days)*86400
}

func roundSeconds(value float64) float64 {
	return float64(int64(value*100)) / 100
}

func runShort(ctx context.Context, name string, args ...string) (string, error) {
	runCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(runCtx, name, args...).Output()
	return string(out), err
}
