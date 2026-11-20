//go:build windows

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// windowsServicePID 从服务自己发布的运行态文件里取受管进程 pid。
// 任务计划程序的 /End 只结束任务记录，aih-server 子进程常会继续存活；
// 因此 Windows 的停止/重启必须以进程为单位，而不是以任务为单位。
func windowsServicePID(home string) int {
	raw, err := os.ReadFile(filepath.Join(home, "run", "go-server-runtime.json"))
	if err != nil || len(raw) > 64*1024 {
		return 0
	}
	var identity struct {
		PID int `json:"pid"`
	}
	if json.Unmarshal(raw, &identity) != nil || identity.PID <= 0 {
		return 0
	}
	return identity.PID
}

func windowsProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	output, err := exec.Command("tasklist", "/FI", fmt.Sprintf("PID eq %d", pid), "/NH").Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(output), strconv.Itoa(pid))
}

// windowsKillPID 强制结束进程树（本机同用户，无提权）。
func windowsKillPID(pid int) {
	if pid <= 0 {
		return
	}
	_ = exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F").Run()
}

func windowsWaitPIDGone(pid int, timeout time.Duration) bool {
	if pid <= 0 {
		return true
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !windowsProcessAlive(pid) {
			return true
		}
		time.Sleep(300 * time.Millisecond)
	}
	return !windowsProcessAlive(pid)
}
