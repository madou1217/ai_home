package distributioninstall

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/platform"
)

func sameInstallPath(left, right string) bool {
	if left == "" || right == "" {
		return false
	}
	left, right = filepath.Clean(left), filepath.Clean(right)
	if goruntime.GOOS == "windows" {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// stoppedDaemonPID is only an observation target, never authority to signal a
// process. Waiting for the saved daemon's exit also covers its supervised Node
// child: releasing the public listener or writer lease alone is not quiescence.
func stoppedDaemonPID(o Options) int {
	raw, err := os.ReadFile(filepath.Join(o.Home, "run", "go-server-runtime.json"))
	if err != nil || len(raw) > 64<<10 {
		return 0
	}
	var record struct {
		PID  int    `json:"pid"`
		Home string `json:"aiHomeDir"`
	}
	if json.Unmarshal(raw, &record) != nil || record.PID <= 0 || !sameInstallPath(record.Home, o.Home) {
		return 0
	}
	return record.PID
}

func waitOwnedStop(ctx context.Context, port, pid int) error {
	deadline := time.NewTimer(45 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(200 * time.Millisecond)
	defer tick.Stop()
	for {
		alive, known := false, true
		if pid > 0 {
			alive, known = platform.ProcessState(pid)
		}
		if known && !alive && !listenerPresent(port) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("无法确认旧 AIH 服务及其子进程已退出；原版本和数据保持不变")
		case <-tick.C:
		}
	}
}

func stopOwnedListener(ctx context.Context, o Options, saved serviceSnapshot) error {
	c := readConfig(o.Home)
	pid := stoppedDaemonPID(o)
	if pid == 0 {
		pid = saved.DaemonPID
	}
	if saved.Running && saved.GoManaged && pid == 0 {
		return errors.New("无法验证旧 AIH 服务退出身份，已保留原版本和数据")
	}
	if !listenerPresent(c.Port) {
		return waitOwnedStop(ctx, c.Port, pid)
	}
	var receipt Receipt
	raw, _ := os.ReadFile(filepath.Join(o.Home, "distribution-install.json"))
	_ = json.Unmarshal(raw, &receipt)
	if pid == 0 && (receipt.Executable != "" || fileExists(filepath.Join(o.Home, "aih.db"))) {
		return errors.New("无法验证正在运行的 AIH 服务身份，已保留原版本和数据")
	}
	// Windows CLI stop may use TerminateProcess and skip Go's supervised-child
	// cleanup. Prefer the authenticated graceful endpoint, including on old
	// releases, then wait for actual process exit rather than an absent port.
	if c.ManagementKey != "" {
		client := &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		req, err := http.NewRequestWithContext(ctx, "POST", "http://127.0.0.1:"+strconv.Itoa(c.Port)+"/v0/management/shutdown", nil)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+c.ManagementKey)
		resp, requestErr := client.Do(req)
		client.CloseIdleConnections()
		if requestErr == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusAccepted || resp.StatusCode == http.StatusOK {
				return waitOwnedStop(ctx, c.Port, pid)
			}
			if resp.StatusCode != http.StatusNotFound && resp.StatusCode != http.StatusMethodNotAllowed && resp.StatusCode != http.StatusNotImplemented {
				return errors.New("旧 AIH 服务拒绝安全停止请求；原版本和数据保持不变")
			}
		} else if !listenerPresent(c.Port) {
			return waitOwnedStop(ctx, c.Port, pid)
		}
	}
	if pid > 0 {
		return errors.New("无法请求旧 AIH 服务安全退出，已保留原版本和数据")
	}
	// Legacy Node releases may not expose the graceful endpoint. Only a trusted
	// installed entry is allowed to stop its own daemon; never signal a PID hint.
	candidates := []string{o.Launcher}
	if receipt.Launcher != "" {
		candidates = append(candidates, receipt.Launcher)
	}
	for _, entry := range candidates {
		if entry == "" {
			continue
		}
		if _, err := os.Stat(entry); err != nil {
			continue
		}
		cmd := exec.CommandContext(ctx, entry, "server", "stop")
		cmd.Env = append(os.Environ(), "AIH_HOME_DIR="+o.Home, "AIH_HOST_HOME="+o.HostHome)
		if err := cmd.Run(); err == nil {
			return waitOwnedStop(ctx, c.Port, pid)
		}
	}
	return errors.New("无法安全停止已有 AIH 服务；原版本和数据保持不变")
}
