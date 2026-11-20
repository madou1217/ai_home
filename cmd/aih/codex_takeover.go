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
	home, err := runtime.userHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return errors.New("codex_takeover_home_unavailable")
	}
	lockPath := filepath.Join(home, ".codex", "thread-writer-locks", threadID+".lock")
	if _, statErr := os.Stat(lockPath); statErr != nil {
		_, _ = fmt.Fprintf(runtime.stdout, "thread %s 没有锁文件：会话空闲，可直接 resume\n", threadID)
		return nil
	}
	holders := lockHolderPIDs(lockPath)
	if len(holders) == 0 {
		_, _ = fmt.Fprintf(runtime.stdout, "thread %s 的锁文件存在但无人持有（陈旧文件，不影响接管）\n", threadID)
		return nil
	}
	for _, pid := range holders {
		_, _ = fmt.Fprintf(runtime.stdout, "占用者: pid=%d %s\n", pid, processSummary(pid))
	}
	if !force {
		return fmt.Errorf("thread %s 仍被 %d 个进程持有；确认要结束它们以接管，请加 --force", threadID, len(holders))
	}
	for _, pid := range holders {
		_ = exec.Command("kill", "-TERM", strconv.Itoa(pid)).Run()
	}
	if waitLockReleased(lockPath, 10*time.Second) {
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] 已释放 thread %s 的写锁\n", threadID)
		return nil
	}
	for _, pid := range lockHolderPIDs(lockPath) {
		_ = exec.Command("kill", "-KILL", strconv.Itoa(pid)).Run()
	}
	if waitLockReleased(lockPath, 5*time.Second) {
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] 已强制释放 thread %s 的写锁\n", threadID)
		return nil
	}
	return fmt.Errorf("thread %s 的写锁仍被占用；请手动检查持有者", threadID)
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
	// 只接受 codex 的 thread 形态，避免把任意路径拼进锁目录。
	if len(threadID) != 36 || strings.Count(threadID, "-") != 4 {
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
