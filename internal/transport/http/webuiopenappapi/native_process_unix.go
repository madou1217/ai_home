//go:build !windows

package webuiopenappapi

import (
	"context"
	"os"
	"os/exec"
	"os/user"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func lookupOSUserHomeDir() string {
	if current, err := user.Current(); err == nil && strings.TrimSpace(current.HomeDir) != "" {
		return strings.TrimSpace(current.HomeDir)
	}
	return ""
}

func startDetachedOS(spec SpawnSpec) (int, error) {
	cmd := exec.Command(spec.File, spec.Args...)
	if spec.Dir != "" {
		cmd.Dir = spec.Dir
	}
	if len(spec.Env) > 0 {
		cmd.Env = spec.Env
	}
	devNull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err == nil {
		cmd.Stdin = devNull
		cmd.Stdout = devNull
		cmd.Stderr = devNull
		defer devNull.Close()
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	pid := 0
	if cmd.Process != nil {
		pid = cmd.Process.Pid
		_ = cmd.Process.Release()
	}
	return pid, nil
}

func isProcessAliveOS(pid int) bool {
	if pid <= 0 {
		return false
	}
	return syscall.Kill(pid, 0) == nil
}

func closeProcessTreeOS(
	ctx context.Context,
	runner CommandRunner,
	pids []int,
	grace time.Duration,
	sleep func(context.Context, time.Duration) error,
) ([]int, error) {
	roots := parsePositivePIDs(pids)
	if len(roots) == 0 {
		return []int{}, nil
	}
	if grace <= 0 {
		grace = 800 * time.Millisecond
	}
	if sleep == nil {
		sleep = defaultSleep
	}

	// 关闭前收集整棵子进程树，避免主进程退出后孤儿 helper 仍占用文件锁/钥匙串。
	// 同时把 AIH 自身及祖先 PID 排除在外，绝不误杀宿主终端或当前服务。
	targets := collectPosixProcessTree(ctx, runner, roots)
	for _, pid := range targets {
		_ = syscall.Kill(pid, syscall.SIGTERM)
	}

	deadline := time.Now().Add(grace)
	for time.Now().Before(deadline) {
		anyAlive := false
		for _, pid := range targets {
			if isProcessAliveOS(pid) {
				anyAlive = true
				break
			}
		}
		if !anyAlive {
			break
		}
		if err := sleep(ctx, 50*time.Millisecond); err != nil {
			break
		}
	}

	for _, pid := range targets {
		if isProcessAliveOS(pid) {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}
	return targets, nil
}

func collectPosixProcessTree(ctx context.Context, runner CommandRunner, roots []int) []int {
	if runner == nil {
		return roots
	}
	out := runner.Run(ctx, "ps", []string{"-axo", "pid=,ppid="}, RunOptions{Timeout: 3 * time.Second})
	if out.Err != nil {
		return roots
	}

	childrenByPPID := make(map[int][]int)
	ppidByPID := make(map[int]int)
	for _, line := range strings.Split(out.Stdout, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		pid, err1 := strconv.Atoi(fields[0])
		ppid, err2 := strconv.Atoi(fields[1])
		if err1 != nil || err2 != nil || pid <= 0 {
			continue
		}
		ppidByPID[pid] = ppid
		if ppid > 0 {
			childrenByPPID[ppid] = append(childrenByPPID[ppid], pid)
		}
	}

	protected := make(map[int]struct{})
	for cur := os.Getpid(); cur > 1; {
		protected[cur] = struct{}{}
		parent, ok := ppidByPID[cur]
		if !ok || parent <= 1 || parent == cur {
			break
		}
		cur = parent
	}

	seen := make(map[int]struct{}, len(roots))
	queue := make([]int, 0, len(roots))
	ordered := make([]int, 0, len(roots)*2)
	for _, root := range roots {
		if _, skip := protected[root]; skip {
			continue
		}
		if _, exists := seen[root]; !exists {
			seen[root] = struct{}{}
			queue = append(queue, root)
		}
	}
	for len(queue) > 0 {
		pid := queue[0]
		queue = queue[1:]
		ordered = append(ordered, pid)
		for _, child := range childrenByPPID[pid] {
			if _, skip := protected[child]; skip {
				continue
			}
			if _, exists := seen[child]; !exists {
				seen[child] = struct{}{}
				queue = append(queue, child)
			}
		}
	}
	if len(ordered) == 0 {
		return roots
	}
	return ordered
}
