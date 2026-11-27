//go:build windows

package applaunch

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"syscall"

	"github.com/madou1217/ai_home/application/launcher"
)

func openWithProxy(ctx context.Context, app launcher.App, mode ProxyMode, proxyURL string, options ProxyOptions) error {
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	target := strings.TrimSpace(app.Path)
	if target == "" {
		return errors.New("应用缺少可启动路径")
	}

	arguments := []string{}
	if mode == ProxyModeChromium && proxyURL != "" {
		if err := ensureProfileDir(options.ProfileDir); err != nil {
			return err
		}
		arguments = chromiumArguments(proxyURL, options.ProfileDir, options.ExtraArgs)
	}
	shellTarget := strings.HasPrefix(strings.ToLower(target), "shell:appsfolder\\") ||
		strings.HasSuffix(strings.ToLower(target), ".lnk")
	var command *exec.Cmd
	switch {
	case shellTarget && mode == ProxyModeChromium && proxyURL != "":
		// shell:AppsFolder 与 .lnk 都不能透传 Chromium 参数：必须解析真实
		// chrome.exe/msedge.exe 再带上 --proxy-server 与独立 profile。
		executable := resolveChromiumExecutable(app)
		if executable == "" {
			return errors.New("无法定位浏览器可执行文件，代理参数无法生效")
		}
		command = exec.Command(executable, arguments...)
	case shellTarget:
		// 其它应用无法透传参数，交给 Shell 激活；代理只能靠环境变量尽力生效。
		command = exec.Command("cmd", "/c", "start", "", target)
	default:
		command = exec.Command(target, arguments...)
	}
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	command.Env = windowsLaunchEnvironment(proxyURL)
	if err := command.Start(); err != nil {
		return err
	}
	go func() { _ = command.Wait() }()
	return nil
}

// windowsLaunchEnvironment replaces any inherited proxy variables with the
// per-instance values. Windows environment variables are case-insensitive, so
// appending a second HTTP_PROXY would leave the effective value undefined.
func windowsLaunchEnvironment(proxyURL string) []string {
	entries := os.Environ()
	overrides := ProxyEnvironment(proxyURL)
	if len(overrides) == 0 {
		return entries
	}
	blocked := make(map[string]struct{}, len(overrides))
	for key := range overrides {
		blocked[strings.ToUpper(key)] = struct{}{}
	}
	filtered := make([]string, 0, len(entries)+len(overrides))
	for _, entry := range entries {
		key, _, ok := strings.Cut(entry, "=")
		if ok {
			if _, drop := blocked[strings.ToUpper(key)]; drop {
				continue
			}
		}
		filtered = append(filtered, entry)
	}
	for _, key := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"} {
		if value := overrides[key]; value != "" {
			filtered = append(filtered, key+"="+value)
		}
	}
	return filtered
}
