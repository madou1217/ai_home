package persistent

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	// DefaultSocketMinAge 是判定死 tmux socket 前必须满足的最小文件年龄（60 秒）。
	DefaultSocketMinAge = 60 * time.Second
	// DefaultSocketDialTimeout 是探测 tmux unix socket 存活的超时上限（50 毫秒）。
	DefaultSocketDialTimeout = 50 * time.Millisecond
)

// SocketPruneOptions 配置失效 tmux socket 文件扫描行为。
type SocketPruneOptions struct {
	Platform  string
	SocketDir string
	UID       *int
	Now       func() time.Time
	MinAge    *time.Duration
	Timeout   time.Duration
	// Probe 在测试或自定义环境中覆盖 unix socket 探测，返回 true 表示仍存活。
	Probe func(ctx context.Context, socketPath string) bool
}

// SocketPruneSummary 描述一次失效 tmux socket 清理扫描的结果计数。
type SocketPruneSummary struct {
	Scanned int `json:"scanned"`
	Removed int `json:"removed"`
	Kept    int `json:"kept"`
	Skipped int `json:"skipped"`
}

// DefaultTmuxSocketDir 返回当前 POSIX 用户的 `/tmp/tmux-<uid>` 目录；Windows 返回空串。
func DefaultTmuxSocketDir(platform string, uid int) string {
	if strings.EqualFold(strings.TrimSpace(platform), "windows") {
		return ""
	}
	if uid < 0 {
		return ""
	}
	return fmt.Sprintf("/tmp/tmux-%d", uid)
}

// PruneStaleTmuxSockets 扫描 tmux socket 目录并删除已超龄且无法建立连接的死 socket。
func PruneStaleTmuxSockets(ctx context.Context, opts SocketPruneOptions) (SocketPruneSummary, error) {
	if ctx == nil {
		return SocketPruneSummary{}, errors.New("socket prune context 为空")
	}
	if err := ctx.Err(); err != nil {
		return SocketPruneSummary{}, err
	}

	platform := strings.TrimSpace(opts.Platform)
	if platform == "" {
		platform = runtime.GOOS
	}
	uid := os.Getuid()
	if opts.UID != nil {
		uid = *opts.UID
	}

	dir := strings.TrimSpace(opts.SocketDir)
	if dir == "" {
		dir = DefaultTmuxSocketDir(platform, uid)
	}

	var summary SocketPruneSummary
	if dir == "" {
		summary.Skipped = 1
		return summary, nil
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		summary.Skipped = 1
		return summary, nil
	}

	minAge := DefaultSocketMinAge
	if opts.MinAge != nil && *opts.MinAge >= 0 {
		minAge = *opts.MinAge
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = DefaultSocketDialTimeout
	}
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	now := nowFn()

	probe := opts.Probe
	if probe == nil {
		probe = func(pCtx context.Context, socketPath string) bool {
			return isUnixSocketAlive(pCtx, socketPath, timeout)
		}
	}

	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return summary, err
		}
		fullPath := filepath.Join(dir, entry.Name())
		info, lstatErr := os.Lstat(fullPath)
		if lstatErr != nil || info.Mode()&os.ModeSocket == 0 {
			continue
		}
		summary.Scanned++
		if now.Sub(info.ModTime()) < minAge {
			summary.Kept++
			continue
		}
		if probe(ctx, fullPath) {
			summary.Kept++
			continue
		}
		if removeErr := os.Remove(fullPath); removeErr != nil {
			summary.Skipped++
			continue
		}
		summary.Removed++
	}
	return summary, nil
}

// isUnixSocketAlive 尝试连接 unix socket；连接成功或超时的（忙）服务端视为存活。
func isUnixSocketAlive(ctx context.Context, socketPath string, timeout time.Duration) bool {
	dialer := net.Dialer{Timeout: timeout}
	conn, err := dialer.DialContext(ctx, "unix", socketPath)
	if err == nil {
		_ = conn.Close()
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	return false
}
