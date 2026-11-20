package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/serverconfig"
	"github.com/madou1217/ai_home/internal/transport/http/webuiserverconfigapi"
)

// `aih zcode-url <zcode://…>`：macOS URL 协议处理器的入口。
//
// 这个命令的职责不是「抢走桌面端的回调」，而是**接管 + 转发兜底**：先按 state
// 问本地 Server 是不是 aih 自己发起的登录任务；不是（或 Server 不可达）就原样
// 交给 ZCode Desktop，绝不吞掉用户授权。
//
// 转发刻意按显式路径解析 app（~/Applications、/Applications）：aih 的沙箱投影
// 会种下 bundle id 相同的 ZCode.app 副本，按 id 转发会把桌面端登录交给影子副本。

const zcodeDesktopBundleID = "dev.zcode.app"
const zcodeURLScheme = "zcode"

var zcodeDesktopAppNames = []string{"ZCode.app", "ZCode Desktop.app"}
var zcodeDesktopAppRoots = []string{"Applications", "/Applications"}

// runZcodeURL 执行一次 `aih zcode-url`（arguments 含 "zcode-url" 本身）。
func runZcodeURL(ctx context.Context, arguments []string, runtime commandRuntime) error {
	target := ""
	if len(arguments) > 1 {
		target = strings.TrimSpace(arguments[1])
	}
	if target == "" {
		_, _ = fmt.Fprintln(runtime.stderr, "[aih] 用法: aih zcode-url <zcode://...>")
		return cliExitCode{code: 1}
	}
	if !strings.HasPrefix(strings.ToLower(target), zcodeURLScheme+"://") {
		// 不是 zcode URL：静默忽略，退出 0（系统可能把别的回调也扔过来）。
		return nil
	}
	state := readZcodeURLState(target)
	delivered, deliverErr := deliverZcodeAuthJob(ctx, runtime, target, state)
	if deliverErr != nil {
		delivered = "server_unavailable"
	}
	if delivered == "handled" {
		short := state
		if len(short) > 12 {
			short = short[:12]
		}
		_, _ = fmt.Fprintf(runtime.stdout, "  ✅ 已交给 aih 登录任务处理（state=%s…）\n", short)
		return nil
	}
	if forwardZcodeToDesktop(runtime, target) {
		_, _ = fmt.Fprintln(runtime.stdout, "  → 非 aih 的授权，已转发给 ZCode Desktop")
		return nil
	}
	_, _ = fmt.Fprintln(runtime.stderr, "[aih] 转发给 ZCode Desktop 失败（它可能未安装）")
	return nil
}

// readZcodeURLState 从 zcode:// URL 里取 state（判定归属的唯一依据）。
func readZcodeURLState(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(parsed.Query().Get("state"))
}

// deliverZcodeAuthJob 把回调交给 Server 的在途登录任务；返回 handled / not_mine / server_unavailable。
func deliverZcodeAuthJob(ctx context.Context, runtime commandRuntime, raw string, state string) (string, error) {
	if state == "" {
		return "not_mine", nil
	}
	aiHomeDir, err := resolveAIHome(runtime)
	if err != nil {
		return "server_unavailable", err
	}
	config, err := webuiserverconfigapi.ReadFullConfig(ctx, aiHomeDir)
	if err != nil {
		return "server_unavailable", err
	}
	port := serverconfig.NormalizePort(config.Port)
	payload, err := json.Marshal(map[string]string{"url": raw, "state": state})
	if err != nil {
		return "server_unavailable", err
	}
	request, err := http.NewRequestWithContext(
		ctx, http.MethodPost,
		fmt.Sprintf("http://127.0.0.1:%d/v0/webui/accounts/zcode/url-callback", port),
		bytes.NewReader(payload),
	)
	if err != nil {
		return "server_unavailable", err
	}
	request.Header.Set("Content-Type", "application/json")
	if key := strings.TrimSpace(config.ManagementKey); key != "" {
		request.Header.Set("Authorization", "Bearer "+key)
	}
	client := &http.Client{Timeout: 10 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return "server_unavailable", err
	}
	defer func() { _ = response.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if response.StatusCode == http.StatusNotFound {
		// Server 在跑但没有匹配任务 → 不是我们的。
		return "not_mine", nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "server_unavailable", nil
	}
	var result struct {
		Handled bool `json:"handled"`
	}
	if json.Unmarshal(body, &result) == nil && result.Handled {
		return "handled", nil
	}
	return "not_mine", nil
}

// forwardZcodeToDesktop 把 URL 交给 ZCode Desktop；安装位置按显式路径解析。
func forwardZcodeToDesktop(runtime commandRuntime, raw string) bool {
	target := strings.TrimSpace(raw)
	if target == "" {
		return false
	}
	appPath := resolveZcodeDesktopAppPath(runtime)
	argv := []string{"-b", zcodeDesktopBundleID, target}
	if appPath != "" {
		argv = []string{"-a", appPath, target}
	}
	command := exec.Command("/usr/bin/open", argv...)
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	return command.Run() == nil
}

func resolveZcodeDesktopAppPath(runtime commandRuntime) string {
	home, err := runtime.userHomeDir()
	if err != nil {
		home = ""
	}
	for _, root := range zcodeDesktopAppRoots {
		base := root
		if !strings.HasPrefix(root, "/") {
			if home == "" {
				continue
			}
			base = filepath.Join(home, root)
		}
		for _, name := range zcodeDesktopAppNames {
			candidate := filepath.Join(base, name)
			if info, statErr := os.Stat(candidate); statErr == nil && info.IsDir() {
				return candidate
			}
		}
	}
	return ""
}
