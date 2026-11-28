package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
)

// runCodexTakeover 处理 `aih codex takeover <thread-id> [--force]`。
//
// codex 0.170 的 thread 单写锁是 ~/.codex/thread-writer-locks/<id>.lock 上的
// flock：进程正常退出会释放，但"卡住的旧进程"仍握着锁，新会话 resume 就会报
// "thread 只能同时只有一个会话发送消息"且无法接管。这里定位持有者，经确认后
// 结束它，让新会话能接着写。
func runCodexTakeover(arguments []string, runtime commandRuntime) error {
	threadID, force, err := parseCodexTakeoverArgs(arguments)
	if err != nil {
		return err
	}
	home, err := resolveCodexHostHome(runtime)
	if err != nil || strings.TrimSpace(home) == "" {
		return errors.New("codex_takeover_home_unavailable")
	}
	lockPath := filepath.Join(home, providerroot.ConfigDir("codex"), "thread-writer-locks", threadID+".lock")
	if _, statErr := os.Stat(lockPath); statErr != nil {
		_, _ = fmt.Fprintf(runtime.stdout, "thread %s 没有锁文件：会话空闲，可直接 resume\n", threadID)
		return nil
	}
	holders := lockHolderPIDs(lockPath)
	if len(holders) == 0 {
		_, _ = fmt.Fprintf(runtime.stdout, "thread %s 的锁文件存在但无人持有（陈旧文件，不影响接管）\n", threadID)
		return nil
	}
	// lsof 和 isCodexProcess 之间进程可能已退出；死 PID 不能当成
	// “不可确认的持有者”拒绝接管，否则刚结束的 Codex 会把 resume 卡死。
	liveHolders := make([]int, 0, len(holders))
	for _, pid := range holders {
		if !processExists(pid) {
			continue
		}
		_, _ = fmt.Fprintf(runtime.stdout, "占用者: pid=%d %s\n", pid, processSummary(pid))
		liveHolders = append(liveHolders, pid)
	}
	holders = liveHolders
	if len(holders) == 0 {
		_, _ = fmt.Fprintf(runtime.stdout, "thread %s 的旧持有者已退出，锁正在释放\n", threadID)
		return nil
	}
	if !force {
		return fmt.Errorf("thread %s 仍被 %d 个进程持有；确认要结束它们以接管，请加 --force", threadID, len(holders))
	}
	for _, pid := range holders {
		if processIsCurrentOrAncestor(pid) {
			return fmt.Errorf("thread %s 由当前 Codex 会话（pid=%d）持有；为避免结束当前会话，不能从其子进程自动接管", threadID, pid)
		}
		if !isCodexProcess(pid) || !processHasAIHCodexAncestor(pid) {
			return fmt.Errorf("thread %s 的持有者 pid=%d 不是 aih 管理的 Codex 进程，拒绝结束", threadID, pid)
		}
	}
	for _, pid := range holders {
		// A Codex process can leave the wrapper/supervisor alive while its
		// process group still owns the lock. Signal the group first; fall back
		// to the exact holder when the group is unavailable.
		if !signalProcessGroup(pid, "TERM") {
			_ = exec.Command("kill", "-TERM", strconv.Itoa(pid)).Run()
		}
	}
	if waitLockReleased(lockPath, 10*time.Second) {
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] 已释放 thread %s 的写锁\n", threadID)
		return nil
	}
	for _, pid := range lockHolderPIDs(lockPath) {
		if !signalProcessGroup(pid, "KILL") {
			_ = exec.Command("kill", "-KILL", strconv.Itoa(pid)).Run()
		}
	}
	if waitLockReleased(lockPath, 5*time.Second) {
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] 已强制释放 thread %s 的写锁\n", threadID)
		return nil
	}
	return fmt.Errorf("thread %s 的写锁仍被占用；请手动检查持有者", threadID)
}

func signalProcessGroup(pid int, signal string) bool {
	if pid <= 0 {
		return false
	}
	err := exec.Command("kill", "-"+signal, "-"+strconv.Itoa(pid)).Run()
	return err == nil
}

func isCodexProcess(pid int) bool {
	if pid <= 0 {
		return false
	}
	output, err := exec.Command("ps", "-o", "command=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return false
	}
	command := strings.TrimSpace(string(output))
	first := command
	if fields := strings.Fields(command); len(fields) > 0 {
		first = fields[0]
	}
	name := strings.ToLower(filepath.Base(strings.Trim(first, "\"'")))
	return name == "aih" || strings.HasPrefix(name, "aih-") || name == "codex" || strings.HasPrefix(name, "codex.")
}

func processExists(pid int) bool {
	if pid <= 0 {
		return false
	}
	output, err := exec.Command("ps", "-o", "pid=", "-p", strconv.Itoa(pid)).Output()
	return err == nil && strings.TrimSpace(string(output)) != ""
}

func processIsCurrentOrAncestor(pid int) bool {
	if pid <= 0 {
		return false
	}
	current := os.Getpid()
	seen := make(map[int]bool)
	for current > 1 && !seen[current] {
		if pid == current {
			return true
		}
		seen[current] = true
		parent, err := processParentPID(current)
		if err != nil || parent <= 0 {
			return false
		}
		current = parent
	}
	return false
}

func processParentPID(pid int) (int, error) {
	output, err := exec.Command("ps", "-o", "ppid=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(output)))
}

func parseCodexTakeoverArgs(arguments []string) (string, bool, error) {
	threadID := ""
	force := false
	for _, argument := range arguments {
		switch {
		case argument == "--force":
			force = true
		case strings.HasPrefix(argument, "--"):
			return "", false, fmt.Errorf("codex takeover 不识别参数 %s", argument)
		case threadID == "":
			threadID = strings.TrimSpace(argument)
		default:
			return "", false, errors.New("用法: aih codex takeover <thread-id> [--force]")
		}
	}
	if threadID == "" {
		return "", false, errors.New("用法: aih codex takeover <thread-id> [--force]")
	}
	// 只接受 UUID 形态，避免把任意路径拼进锁目录。
	if !isCodexThreadID(threadID) {
		return "", false, fmt.Errorf("thread id 格式不正确: %s", threadID)
	}
	return threadID, force, nil
}

// lockHolderPIDs 用 lsof 找 flock 持有者；没有 lsof 或无人持有时返回空。
func lockHolderPIDs(lockPath string) []int {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "lsof", "-t", lockPath).Output()
	if err != nil {
		return nil
	}
	var pids []int
	for _, field := range strings.Fields(string(output)) {
		if pid, convErr := strconv.Atoi(field); convErr == nil && pid > 0 {
			pids = append(pids, pid)
		}
	}
	return pids
}

func waitLockReleased(lockPath string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if len(lockHolderPIDs(lockPath)) == 0 {
			return true
		}
		time.Sleep(200 * time.Millisecond)
	}
	return false
}

func processSummary(pid int) string {
	output, err := exec.Command("ps", "-o", "etime=,command=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func codexResumeThreadID(arguments []string) (string, bool) {
	index := -1
	if len(arguments) >= 2 && arguments[1] == "resume" {
		index = 1
	} else if len(arguments) >= 3 && !strings.HasPrefix(arguments[1], "-") && arguments[2] == "resume" {
		index = 2
	}
	if index < 0 || index+1 >= len(arguments) {
		return "", false
	}
	candidate := strings.TrimSpace(arguments[index+1])
	if !isCodexThreadID(candidate) {
		return "", false
	}
	return candidate, true
}

func isCodexThreadID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	for index, char := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			continue
		}
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')) {
			return false
		}
	}
	return true
}

func resolveCodexHostHome(runtime commandRuntime) (string, error) {
	if runtime.lookupEnv != nil {
		if home := strings.TrimSpace(readEnv(runtime.lookupEnv, "AIH_HOST_HOME")); home != "" {
			return home, nil
		}
	}
	if runtime.userHomeDir == nil {
		return "", errors.New("codex_takeover_home_unavailable")
	}
	return runtime.userHomeDir()
}

// ensureCodexResumeAvailable 在 resume 前处理 thread 锁，但绝不主动杀活进程：
//   - 无活持有者：删除陈旧锁，允许启动；
//   - 活持有者属于 aih：拒绝并提示从 aih ss / 原终端处理；
//   - 活持有者不是 aih：拒绝，绝不抢锁。
func ensureCodexResumeAvailable(threadID string, runtime commandRuntime) error {
	home, err := resolveCodexHostHome(runtime)
	if err != nil || strings.TrimSpace(home) == "" {
		return errors.New("codex_takeover_home_unavailable")
	}
	lockPath := filepath.Join(home, providerroot.ConfigDir("codex"), "thread-writer-locks", threadID+".lock")
	if _, statErr := os.Stat(lockPath); statErr != nil {
		return nil
	}
	holders := lockHolderPIDs(lockPath)
	live := make([]int, 0, len(holders))
	for _, pid := range holders {
		if processExists(pid) {
			live = append(live, pid)
		}
	}
	if len(live) == 0 {
		if removeErr := os.Remove(lockPath); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			return fmt.Errorf("thread %s 的陈旧锁无法清理: %w", threadID, removeErr)
		}
		_, _ = fmt.Fprintf(runtime.stderr, "[aih] 已释放 thread %s 的陈旧锁\n", threadID)
		return nil
	}
	for _, pid := range live {
		if !processHasAIHCodexAncestor(pid) {
			return fmt.Errorf("thread %s 正被非 aih Codex 进程 pid=%d 持有；请先退出该 Codex 会话，再 resume", threadID, pid)
		}
	}
	return fmt.Errorf("thread %s 正被 aih 进程 pid=%d 持有；请先在原终端退出，或从 aih ss 进入已有 tmux 会话；确认接管请显式执行 aih codex takeover %s --force", threadID, live[0], threadID)
}
