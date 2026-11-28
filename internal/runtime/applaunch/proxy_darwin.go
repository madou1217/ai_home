//go:build darwin

package applaunch

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/application/launcher"
	"github.com/madou1217/ai_home/internal/runtime/netguard"
)

// openChromiumSandboxed runs the bundle executable directly under
// sandbox-exec so external IP traffic is denied and only the loopback proxy is
// reachable. It is opt-in because it bypasses LaunchServices/TCC assumptions.
func openAppSandboxed(app launcher.App, mode ProxyMode, proxyURL string, options ProxyOptions) error {
	bundle := strings.TrimSpace(app.Path)
	name := strings.TrimSuffix(filepath.Base(bundle), ".app")
	executable := filepath.Join(bundle, "Contents", "MacOS", name)
	if _, err := os.Stat(executable); err != nil {
		return errors.New("找不到应用可执行文件: " + executable)
	}
	args := []string{}
	if mode == ProxyModeChromium || isElectronBundle(bundle) {
		args = append(args, chromiumArguments(proxyURL, options.ProfileDir, options.ExtraArgs)...)
		args = append(args, "--no-sandbox")
	}
	command, cleanup, err := netguard.NewSandboxCommand(context.Background(), netguard.SandboxConfig{
		ProxyURL: proxyURL,
		DNS:      netguard.DNSProxy,
	}, executable, args...)
	if err != nil {
		return err
	}
	if err := command.Start(); err != nil {
		cleanup()
		return err
	}
	go func() {
		_ = command.Wait()
		cleanup()
	}()
	return nil
}

// isElectronBundle detects the Chromium/Electron runtime inside a .app. Such
// apps accept --proxy-server even when the catalog classified them as
// environment-only.
func isElectronBundle(bundle string) bool {
	if _, err := os.Stat(filepath.Join(bundle, "Contents", "Resources", "app.asar")); err == nil {
		return true
	}
	framework := filepath.Join(bundle, "Contents", "Frameworks", "Electron Framework.framework")
	_, err := os.Stat(framework)
	return err == nil
}

func openWithProxy(_ context.Context, app launcher.App, mode ProxyMode, proxyURL string, options ProxyOptions) error {
	target := strings.TrimSpace(app.Path)
	if target == "" {
		return errors.New("应用缺少可启动路径")
	}
	args := []string{"-n", "-a", target}
	if proxyURL != "" {
		for key, value := range ProxyEnvironment(proxyURL) {
			// 只传大写一套；open 会把变量原样写入子进程环境，重复的小写值没有意义。
			switch key {
			case "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY":
				args = append(args, "--env", key+"="+value)
			}
		}
	}
	if proxyURL != "" && (options.Sandbox || os.Getenv("AIH_NETGUARD_SANDBOX_GUI") == "1") && strings.HasSuffix(target, ".app") {
		if err := ensureProfileDir(options.ProfileDir); err != nil {
			return err
		}
		return openAppSandboxed(app, mode, proxyURL, options)
	}
	if mode == ProxyModeChromium && proxyURL != "" {
		if err := ensureProfileDir(options.ProfileDir); err != nil {
			return err
		}
		args = append(args, "--args")
		args = append(args, chromiumArguments(proxyURL, options.ProfileDir, options.ExtraArgs)...)
	}
	command := exec.Command("/usr/bin/open", args...)
	if output, err := command.CombinedOutput(); err != nil {
		message := strings.TrimSpace(string(output))
		if message != "" {
			return errors.New("启动应用失败: " + message)
		}
		return err
	}
	return nil
}
