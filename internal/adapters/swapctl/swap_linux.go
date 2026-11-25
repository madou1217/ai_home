//go:build linux

package swapctl

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const (
	fstabPath = "/etc/fstab"

	minSwapMB = 512
	maxSwapMB = 65536
)

// 两个固定路径轮换：swapfile 与 swapfile.1。
// 绝不能改名一个正在使用的交换文件（内核返回 EPERM），所以调整大小时
// 先在空闲路径上建好并挂上，再把旧路径 swapoff + 删除。
var swapCandidates = []string{"/swapfile", "/swapfile.1"}

// managedSwapPaths 连同迁移期的临时名一起纳入清理范围。
func managedSwapPaths() []string {
	return append(append([]string{}, swapCandidates...), "/swapfile.aih-next")
}

func isSwapPath(value string) bool {
	for _, path := range managedSwapPaths() {
		if value == path {
			return true
		}
	}
	return false
}

// activeSwapPaths 返回当前挂在 /proc/swaps 里的受管文件（按出现顺序）。
func activeSwapPaths() []string {
	content, err := os.ReadFile("/proc/swaps")
	if err != nil {
		return nil
	}
	active := []string{}
	for _, line := range strings.Split(string(content), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && isSwapPath(fields[0]) {
			active = append(active, fields[0])
		}
	}
	return active
}

func realRunner(name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	output, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		return string(output), fmt.Errorf("%s 超时", name)
	}
	return string(output), err
}

func (manager *Manager) run() CommandRunner {
	if manager != nil && manager.Run != nil {
		return manager.Run
	}
	return realRunner
}

// sudo 执行特权命令；-n 保证不会在无终端时挂起等待密码。
func (manager *Manager) sudo(name string, args ...string) (string, error) {
	return manager.run()("sudo", append([]string{"-n", name}, args...)...)
}

// Status 读取 /proc 与 fstab，不修改系统。
func (manager *Manager) Status() Status {
	status := Status{Supported: true}
	if _, err := os.Stat("/proc/swaps"); err != nil {
		return Status{Supported: false, Reason: "当前系统没有 /proc/swaps"}
	}
	if _, err := manager.sudo("true"); err != nil {
		status.Reason = "需要免密 sudo 才能管理交换空间"
	} else {
		status.CanChange = true
	}
	// 工具检查走 sudo：服务进程的 PATH 通常不含 /usr/sbin，直接 command -v 会误报缺失。
	for _, tool := range []string{"mkswap", "swapon", "swapoff"} {
		if _, err := manager.sudo("sh", "-c", "command -v "+tool); err != nil {
			status.CanChange = false
			status.Reason = "缺少 " + tool
		}
	}
	if content, err := os.ReadFile("/proc/meminfo"); err == nil {
		for _, line := range strings.Split(string(content), "\n") {
			fields := strings.Fields(line)
			if len(fields) < 2 {
				continue
			}
			kb, _ := strconv.Atoi(fields[1])
			switch fields[0] {
			case "SwapTotal:":
				status.TotalMB = kb / 1024
			case "SwapFree:":
				status.FreeMB = kb / 1024
			}
		}
		status.UsedMB = status.TotalMB - status.FreeMB
	}
	if active := activeSwapPaths(); len(active) > 0 {
		status.Active = true
		status.File = active[0]
	}
	if status.File == "" {
		status.File = swapCandidates[0]
	}
	if content := manager.readFstab(); content != "" && status.File != "" {
		for _, line := range strings.Split(content, "\n") {
			trimmed := strings.TrimSpace(line)
			if trimmed == "" || strings.HasPrefix(trimmed, "#") {
				continue
			}
			if strings.Fields(trimmed)[0] == status.File {
				status.Persisted = true
			}
		}
	}
	return status
}

// Apply 把交换空间调整到 sizeMB。
// 先在空闲路径上建好并挂上新文件，再撤掉旧文件：swapoff 时页面有落点，
// 全程不重命名使用中的交换文件。
func (manager *Manager) Apply(sizeMB int) (Status, error) {
	if sizeMB < minSwapMB || sizeMB > maxSwapMB {
		return Status{}, fmt.Errorf("swap_size 需在 %d-%d MB 之间", minSwapMB, maxSwapMB)
	}
	current := manager.Status()
	if !current.Supported || !current.CanChange {
		return current, fmt.Errorf("swap_unsupported")
	}

	target := swapCandidates[0]
	if current.File == swapCandidates[0] {
		target = swapCandidates[1]
	}
	// 先清掉同路径的残留文件。
	_, _ = manager.sudo("swapoff", target)
	if _, err := manager.sudo("rm", "-f", target); err != nil {
		return current, fmt.Errorf("swap_cleanup_failed: %v", err)
	}
	if _, err := manager.sudo("fallocate", "-l", fmt.Sprintf("%dM", sizeMB), target); err != nil {
		if _, ddErr := manager.sudo("dd", "if=/dev/zero", "of="+target, "bs=1M",
			"count="+strconv.Itoa(sizeMB), "status=none"); ddErr != nil {
			return current, fmt.Errorf("swap_create_failed: %v", ddErr)
		}
	}
	if _, err := manager.sudo("chmod", "600", target); err != nil {
		return current, fmt.Errorf("swap_chmod_failed: %v", err)
	}
	if output, err := manager.sudo("mkswap", target); err != nil {
		return current, fmt.Errorf("swap_mkswap_failed: %s", strings.TrimSpace(output))
	}
	if output, err := manager.sudo("swapon", target); err != nil {
		return current, fmt.Errorf("swap_swapon_failed: %s", strings.TrimSpace(output))
	}
	// 新交换已挂上，再撤旧文件；撤不掉就回滚新文件，保持原状。
	for _, oldPath := range activeSwapPaths() {
		if oldPath == target {
			continue
		}
		if output, err := manager.sudo("swapoff", oldPath); err != nil {
			_, _ = manager.sudo("swapoff", target)
			_, _ = manager.sudo("rm", "-f", target)
			return current, fmt.Errorf("swap_swapoff_failed: %s", strings.TrimSpace(output))
		}
		if _, err := manager.sudo("rm", "-f", oldPath); err != nil {
			return manager.Status(), fmt.Errorf("swap_remove_old_failed: %v", err)
		}
	}
	if err := manager.writeFstab(target); err != nil {
		return manager.Status(), err
	}
	return manager.Status(), nil
}

// Remove 关闭并删除所有受管交换文件。
func (manager *Manager) Remove() (Status, error) {
	current := manager.Status()
	if !current.Supported || !current.CanChange {
		return current, fmt.Errorf("swap_unsupported")
	}
	for _, path := range managedSwapPaths() {
		_, _ = manager.sudo("swapoff", path)
	}
	for _, path := range managedSwapPaths() {
		if _, err := manager.sudo("rm", "-f", path); err != nil {
			return current, fmt.Errorf("swap_remove_failed: %v", err)
		}
	}
	if err := manager.removeFstab(); err != nil {
		return manager.Status(), err
	}
	return manager.Status(), nil
}

// writeFstab 让 /etc/fstab 只保留一条指向当前生效文件的 swap 行。
// readFstab 读取 /etc/fstab；该文件常为 0600 root，服务进程读不到时退回 sudo。
func (manager *Manager) readFstab() string {
	if content, err := os.ReadFile(fstabPath); err == nil {
		return string(content)
	}
	output, err := manager.sudo("cat", fstabPath)
	if err != nil {
		return ""
	}
	return output
}

func (manager *Manager) writeFstab(activePath string) error {
	script := strings.Join([]string{
		"tmp=$(mktemp)",
		`grep -v -E '^[[:space:]]*/swapfile(\.1)?[[:space:]]' ` + fstabPath + ` > "$tmp"`,
		"printf '%s\\n' " + shellQuote(activePath+" none swap sw 0 0") + " >> \"$tmp\"",
		"mv -f \"$tmp\" " + fstabPath,
	}, "\n")
	if output, err := manager.sudo("sh", "-c", script); err != nil {
		return fmt.Errorf("swap_fstab_write_failed: %s", strings.TrimSpace(output))
	}
	return nil
}

func (manager *Manager) removeFstab() error {
	script := strings.Join([]string{
		"tmp=$(mktemp)",
		`grep -v -E '^[[:space:]]*/swapfile(\.1|\.aih-next)?[[:space:]]' ` + fstabPath + ` > "$tmp"`,
		"mv -f \"$tmp\" " + fstabPath,
	}, "\n")
	if output, err := manager.sudo("sh", "-c", script); err != nil {
		return fmt.Errorf("swap_fstab_write_failed: %s", strings.TrimSpace(output))
	}
	return nil
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
